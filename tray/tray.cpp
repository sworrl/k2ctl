#include "tray.h"

#include <QApplication>
#include <QColorDialog>
#include <QDesktopServices>
#include <QDialog>
#include <QDialogButtonBox>
#include <QFormLayout>
#include <QLineEdit>
#include <QMessageBox>
#include <QPushButton>
#include <QRegularExpression>
#include <QPainter>
#include <QSettings>
#include <QDateTime>
#include <QLinearGradient>
#include <QInputDialog>
#include <QSpinBox>
#include <QWidgetAction>

#include "camerawindow.h"
#include "costwindow.h"
#include "sensorswindow.h"

// Durations as h:mm:ss and clock times as 24-hour HH:mm, everywhere.
static QString fmtDur(int s) {
    if (s <= 0) return "-";
    const int h = s / 3600, m = (s % 3600) / 60, sec = s % 60;
    return QString("%1:%2:%3").arg(h).arg(m, 2, 10, QChar('0')).arg(sec, 2, 10, QChar('0'));
}
static QString doneAt(int secondsLeft) {
    if (secondsLeft <= 0) return "-";
    return QDateTime::currentDateTime().addSecs(secondsLeft).toString("HH:mm");
}

TrayApp::TrayApp(QObject *parent) : QObject(parent) {
    loadSettings();
    m_tray.setContextMenu(&m_menu);
    m_tray.setIcon(stateIcon());
    m_tray.setToolTip("K2: connecting…");
    m_tray.show();

    connect(&m_api, &ApiClient::statusReceived, this, &TrayApp::applyStatus);
    connect(&m_api, &ApiClient::profilesReceived, this, [this](const QJsonArray &p) { m_profiles = p; });
    connect(&m_api, &ApiClient::requestFailed, this, [this](const QString &what, const QString &err) {
        if (what == "status") {
            if (m_online || m_lastError != err) {
                m_online = false;
                m_lastError = err;
                m_tray.setIcon(stateIcon());
                m_tray.setToolTip("K2: backend unreachable (" + err + ")");
                rebuildMenu();
            }
            return;
        }
        m_tray.showMessage("K2", what + " failed: " + err, QSystemTrayIcon::Warning, 5000);
    });
    connect(&m_api, &ApiClient::materialRefused, this, [this](int box, int slot, const QString &profileId, const QString &reason) {
        QMessageBox mb(QMessageBox::Warning, "Not CFS-compatible",
            QString("This spool is not CFS-compatible:\n\n%1\n\nCreality's guidance is to print it from the external spool holder. "
                    "Record it in this CFS bay anyway?").arg(reason));
        QPushButton *anyway = mb.addButton("Load anyway", QMessageBox::DestructiveRole);
        mb.addButton(QMessageBox::Cancel);
        mb.exec();
        if (mb.clickedButton() == anyway) m_api.setMaterial(box, slot, profileId, QString(), true);
    });
    connect(&m_api, &ApiClient::actionDone, this, [this](const QString &what, const QJsonObject &r) {
        if (what == "fans" || what == "fans recommended") {
            if (what == "fans recommended") {
                const QJsonObject a = r.value("applied").toObject();
                m_tray.showMessage("K2 fans", QString("part %1% · aux %2% · chamber %3%  (%4)").arg(a.value("part").toInt())
                    .arg(a.value("aux").toInt()).arg(a.value("chamber").toInt()).arg(a.value("source").toString()), QSystemTrayIcon::Information, 4000);
            }
            m_api.fetchStatus();
            return;
        }
        if (what == "set material")
            m_tray.showMessage("K2", QString("%1 set to %2 %3").arg(r.value("slot").toString(),
                r.value("material").toObject().value("Vendor").toString(), r.value("material").toObject().value("Name").toString()),
                QSystemTrayIcon::Information, 4000);
        m_api.fetchStatus();
    });
    connect(&m_tray, &QSystemTrayIcon::activated, this, [this](QSystemTrayIcon::ActivationReason r) {
        if (r == QSystemTrayIcon::Trigger) openDashboard();
        else if (r == QSystemTrayIcon::MiddleClick) openSensors();
    });
    connect(&m_menu, &QMenu::aboutToShow, this, &TrayApp::rebuildMenu);
    connect(&m_timer, &QTimer::timeout, this, [this] { m_api.fetchStatus(); });
    m_timer.start();
    m_api.fetchStatus();
    m_api.fetchProfiles();
    rebuildMenu();
    if (m_api.baseUrl().isEmpty()) QTimer::singleShot(500, this, &TrayApp::openSettings);
}

void TrayApp::loadSettings() {
    QSettings s("k2ctl", "tray");
    // No default: the installer writes ~/.config/k2ctl/tray.conf, and a first run with
    // nothing configured opens the settings dialog instead of polling a made-up address.
    m_api.setBaseUrl(QUrl(s.value("backend", "").toString()));
    m_mjpeg = QUrl(s.value("mjpeg", "").toString());
    m_timer.setInterval(s.value("poll_ms", 3000).toInt());
}

void TrayApp::applyStatus(const QJsonObject &st) {
    m_status = st;
    m_online = true;
    m_lastError.clear();
    m_tray.setIcon(stateIcon());
    m_tray.setToolTip("K2: " + stateSummary());
    if (m_sensors && m_sensors->isVisible()) m_sensors->update(st);
    if (m_profiles.isEmpty()) m_api.fetchProfiles();
}

QString TrayApp::stateSummary() const {
    if (!m_online) return "offline";
    const QJsonObject job = m_status.value("job").toObject();
    const QJsonObject temps = m_status.value("temps").toObject();
    auto t = [&](const QString &k) {
        const QJsonObject o = temps.value(k).toObject();
        return QString("%1/%2°").arg(o.value("actual").toDouble(), 0, 'f', 0).arg(o.value("target").toDouble(), 0, 'f', 0);
    };
    QString s = job.value("state").toString("standby");
    if (s == "printing" || s == "paused")
        s += QString(" %1% · %2 left · done %3").arg(job.value("progress").toDouble(), 0, 'f', 1).arg(fmtDur(job.value("time_left_s").toInt())).arg(doneAt(job.value("time_left_s").toInt()));
    return s + " · nozzle " + t("nozzle") + " · bed " + t("bed");
}

// A printer glyph on a state-colored badge; the badge fills with progress.
QIcon TrayApp::stateIcon() const {
    // The K2CTL icon with a state badge in the corner: grey standby, blue printing
    // (badge fills with progress), amber paused, red error/offline, green complete.
    const QString st = m_online ? m_status.value("job").toObject().value("state").toString("standby") : "offline";
    QColor c("#8b95a3");
    if (st == "printing") c = QColor("#4fb3ff");
    else if (st == "paused") c = QColor("#ffb648");
    else if (st == "error" || st == "offline") c = QColor("#ff5c5c");
    else if (st == "complete") c = QColor("#3ddc84");
    static const QPixmap base(":/k2ctl-icon.png");
    QPixmap px(128, 128);
    px.fill(Qt::transparent);
    QPainter p(&px);
    p.setRenderHint(QPainter::Antialiasing);
    p.setRenderHint(QPainter::SmoothPixmapTransform);
    p.drawPixmap(QRect(0, 0, 128, 128), base);
    if (st == "offline") {
        p.fillRect(px.rect(), QColor(0, 0, 0, 110));
    }
    // badge
    const QRectF badge(84, 84, 40, 40);
    p.setPen(QPen(QColor("#0f1216"), 4));
    p.setBrush(c);
    if (st == "printing") {
        const double pct = m_status.value("job").toObject().value("progress").toDouble() / 100.0;
        p.setBrush(QColor(c.red(), c.green(), c.blue(), 90));
        p.drawEllipse(badge);
        p.setPen(Qt::NoPen);
        p.setBrush(c);
        p.drawPie(badge.adjusted(2, 2, -2, -2), 90 * 16, int(-360 * 16 * pct));
    } else {
        p.drawEllipse(badge);
    }
    p.end();
    return QIcon(px);
}

void TrayApp::rebuildMenu() {
    m_menu.clear();
    const QJsonObject job = m_status.value("job").toObject();
    const QJsonObject printer = m_status.value("printer").toObject();
    const QString state = m_online ? job.value("state").toString("standby") : "offline";

    QAction *title = m_menu.addAction((printer.value("name").toString().isEmpty() ? "K2" : printer.value("name").toString()) + ": " + state);
    title->setEnabled(false);
    QFont bold = title->font();
    bold.setBold(true);
    title->setFont(bold);
    if (m_online) {
        m_menu.addAction(stateSummary().section(" · ", 1))->setEnabled(false);
        const QJsonObject temps = m_status.value("temps").toObject();
        if (temps.contains("chamber"))
            m_menu.addAction(QString("chamber %1° · fans part %2% aux %3%").arg(temps.value("chamber").toObject().value("actual").toDouble(), 0, 'f', 0)
                .arg(m_status.value("fans").toObject().value("part").toInt()).arg(m_status.value("fans").toObject().value("aux").toInt()))->setEnabled(false);
        if (!job.value("file").toString().isEmpty() && state != "standby") {
            const QString f = job.value("file").toString().section('/', -1);
            m_menu.addAction(QString("%1 · layer %2/%3 · %4 elapsed").arg(f).arg(job.value("layer").toInt()).arg(job.value("total_layers").toInt())
                .arg(fmtDur(job.value("elapsed_s").toInt())))->setEnabled(false);
        }
    } else if (!m_lastError.isEmpty()) {
        m_menu.addAction("backend: " + m_lastError)->setEnabled(false);
    }
    m_menu.addSeparator();

    QMenu *fil = m_menu.addMenu("Filament slots");
    buildFilamentMenu(fil);
    m_menu.addSeparator();

    if (state == "printing") {
        m_menu.addAction("Pause print", this, [this] { m_api.printAction("pause"); });
    } else {
        QAction *res = m_menu.addAction("Resume print", this, [this] { m_api.printAction("resume"); });
        res->setEnabled(state == "paused");
    }
    QAction *cancel = m_menu.addAction("Cancel print…", this, &TrayApp::confirmCancel);
    cancel->setEnabled(state == "printing" || state == "paused");
    QAction *light = m_menu.addAction("Chamber light");
    light->setCheckable(true);
    light->setChecked(m_status.value("light").toBool());
    light->setEnabled(m_online);
    connect(light, &QAction::triggered, this, [this](bool on) { m_api.setLight(on); });
    QMenu *fans = m_menu.addMenu("Fans");
    fans->setEnabled(m_online);
    buildFansMenu(fans);
    m_menu.addSeparator();

    m_menu.addAction("Webcam…", this, &TrayApp::openCamera);
    m_menu.addAction("Sensors monitor…", this, &TrayApp::openSensors);
    m_menu.addAction("Estimate print cost…", this, &TrayApp::openCost);
    m_menu.addAction("Open dashboard", this, &TrayApp::openDashboard);
    m_menu.addAction("Settings…", this, &TrayApp::openSettings);
    m_menu.addSeparator();
    m_menu.addAction("Quit", qApp, &QApplication::quit);
}

// One submenu per slot; inside, profiles grouped by vendor. Choosing one
// rewrites that slot's material record on the printer.
void TrayApp::buildFilamentMenu(QMenu *menu) {
    const QJsonObject cfs = m_status.value("cfs").toObject();
    const bool printing = m_status.value("job").toObject().value("state").toString() == "printing";
    const QJsonArray boxes = cfs.value("boxes").toArray();
    if (!m_online || boxes.isEmpty()) {
        menu->addAction(m_online ? "No filament boxes reported" : "offline")->setEnabled(false);
        return;
    }
    for (const QJsonValue &bv : boxes) {
        const QJsonObject box = bv.toObject();
        const int boxId = box.value("id").toInt();
        for (const QJsonValue &sv : box.value("slots").toArray()) {
            const QJsonObject slot = sv.toObject();
            const int slotId = slot.value("id").toInt();
            const bool feeding = slot.value("selected").toBool();
            QString label = QString("%1 · %2 %3").arg(slot.value("label").toString(), slot.value("vendor").toString(), slot.value("name").toString());
            if (feeding) label += "  ● feeding";
            const bool cfsBay = box.value("type").toInt() == 0;
            static const QRegularExpression flexRe("TPU|TPE|FLEX", QRegularExpression::CaseInsensitiveOption);
            if (cfsBay && flexRe.match(slot.value("type").toString() + " " + slot.value("name").toString()).hasMatch())
                label += "  TPU: use the external spool holder";
            QMenu *sm = menu->addMenu(label);
            sm->setIcon(QIcon(slotSwatch(slot)));
            QAction *cur = sm->addAction(QString("%1 · %2-%3 °C · PA %4").arg(slot.value("type").toString())
                .arg(slot.value("min_temp").toDouble(), 0, 'f', 0).arg(slot.value("max_temp").toDouble(), 0, 'f', 0).arg(slot.value("pressure").toDouble()));
            cur->setEnabled(false);
            sm->addSeparator();
            if (printing && feeding) {
                sm->addAction("locked while feeding the print")->setEnabled(false);
                continue;
            }
            QMap<QString, QMenu *> vendors;
            for (const QJsonValue &pv : m_profiles) {
                const QJsonObject p = pv.toObject();
                const QString vendor = p.value("vendor").toString();
                if (!vendors.contains(vendor)) vendors[vendor] = sm->addMenu(vendor);
                const QString id = p.value("id").toString();
                const QJsonObject cfsRule = p.value("cfs").toObject();
                const bool bad = cfsBay && p.contains("cfs") && !cfsRule.value("ok").toBool();
                QAction *a = vendors[vendor]->addAction(QString("%1  (%2 %3-%4°)%5").arg(p.value("name").toString(), p.value("type").toString())
                    .arg(p.value("min_temp").toInt()).arg(p.value("max_temp").toInt()).arg(bad ? "  (not for CFS)" : ""));
                QStringList tip;
                if (bad) tip << "Not CFS-compatible: " + cfsRule.value("reason").toString();
                if (p.contains("dry")) tip << QString("Dry %1 °C for %2 h").arg(p.value("dry").toObject().value("temp_c").toInt()).arg(p.value("dry").toObject().value("hours").toInt());
                for (const QJsonValue &wv : p.value("warnings").toArray()) tip << wv.toString();
                if (!tip.isEmpty()) a->setToolTip(tip.join("\n"));
                connect(a, &QAction::triggered, this, [this, boxId, slotId, id] { m_api.setMaterial(boxId, slotId, id); });
            }
            sm->addSeparator();
            const QString curColor = slot.value("color").toString("#ffffff");
            QStringList curColors;
            for (const QJsonValue &cv : slot.value("colors").toArray()) curColors << cv.toString();
            sm->addAction("Rainbow…", this, [this, boxId, slotId, curColors] {
                bool ok = false;
                const QString text = QInputDialog::getText(nullptr, "Rainbow spool",
                    "Colors along the spool, comma separated (2 to 8 hex values).\nThe printer is told the middle one; the list is kept by k2ctl.",
                    QLineEdit::Normal, curColors.size() > 1 ? curColors.join(", ") : "#ff4d4d, #ffb400, #3ddc84, #2b8cff, #b56cff", &ok);
                if (!ok) return;
                QStringList cs;
                for (QString c : text.split(',', Qt::SkipEmptyParts)) {
                    c = c.trimmed();
                    if (!c.startsWith('#')) c.prepend('#');
                    if (QColor(c).isValid()) cs << c;
                }
                if (cs.size() < 2 || cs.size() > 8) {
                    m_tray.showMessage("K2", "Rainbow needs 2 to 8 valid #RRGGBB colors", QSystemTrayIcon::Warning, 4000);
                    return;
                }
                m_api.setMaterialColors(boxId, slotId, cs);
            });
            sm->addAction("Change color…", this, [this, boxId, slotId, curColor] {
                const QColor c = QColorDialog::getColor(QColor(curColor), nullptr, "Slot color");
                if (c.isValid()) {
                    // Keep the current material, only rewrite the color.
                    QJsonObject slotNow;
                    for (const QJsonValue &bv2 : m_status.value("cfs").toObject().value("boxes").toArray())
                        for (const QJsonValue &sv2 : bv2.toObject().value("slots").toArray())
                            if (bv2.toObject().value("id").toInt() == boxId && sv2.toObject().value("id").toInt() == slotId) slotNow = sv2.toObject();
                    m_api.setMaterial(boxId, slotId, QString(), c.name());
                }
            });
        }
    }
}

// Menu swatch for a bay: solid color, or a horizontal gradient for a
// multi-color (rainbow) spool whose color shifts as it is used.
QPixmap TrayApp::slotSwatch(const QJsonObject &slot) {
    QStringList cs;
    for (const QJsonValue &cv : slot.value("colors").toArray()) cs << cv.toString();
    if (cs.isEmpty()) cs << slot.value("color").toString("#888888");
    QPixmap sw(16, 16);
    sw.fill(Qt::transparent);
    QPainter p(&sw);
    p.setRenderHint(QPainter::Antialiasing);
    if (cs.size() == 1) {
        p.setBrush(QColor(cs[0]));
    } else {
        QLinearGradient g(0, 0, 16, 0);
        for (int i = 0; i < cs.size(); ++i) g.setColorAt(double(i) / (cs.size() - 1), QColor(cs[i]));
        p.setBrush(g);
    }
    p.setPen(QColor(255, 255, 255, 60));
    p.drawRoundedRect(0, 0, 15, 15, 3, 3);
    p.end();
    return sw;
}

void TrayApp::confirmCancel() {
    if (QMessageBox::question(nullptr, "Cancel print", "Cancel the running print on the K2?") == QMessageBox::Yes)
        m_api.printAction("cancel");
}

void TrayApp::openDashboard() { QDesktopServices::openUrl(m_api.baseUrl()); }

void TrayApp::openSensors() {
    if (!m_sensors) m_sensors = new SensorsWindow;
    if (!m_status.isEmpty()) m_sensors->update(m_status);
    m_sensors->show();
    m_sensors->raise();
    m_sensors->activateWindow();
}

void TrayApp::openCost() {
    if (!m_cost) m_cost = new CostWindow;
    m_cost->setBackend(m_api.baseUrl());
    m_cost->browse();
}

void TrayApp::openCamera() {
    if (!m_camera) m_camera = new CameraWindow;
    m_camera->open(m_api.baseUrl(), m_mjpeg);
}

void TrayApp::openSettings() {
    QDialog dlg;
    dlg.setWindowTitle("K2 tray settings");
    auto *form = new QFormLayout(&dlg);
    QSettings s("k2ctl", "tray");
    auto *backend = new QLineEdit(s.value("backend", "").toString(), &dlg);
    backend->setPlaceholderText("http://<printer-ip>:8085");
    auto *mjpeg = new QLineEdit(s.value("mjpeg", "").toString(), &dlg);
    mjpeg->setPlaceholderText("leave empty on a K2 (only K1-series printers have MJPEG)");
    auto *poll = new QSpinBox(&dlg);
    poll->setRange(1000, 60000);
    poll->setSingleStep(500);
    poll->setSuffix(" ms");
    poll->setValue(s.value("poll_ms", 3000).toInt());
    form->addRow("Backend URL", backend);
    form->addRow("MJPEG stream URL (fallback)", mjpeg);
    form->addRow("Poll interval", poll);
    auto *bb = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel, &dlg);
    form->addRow(bb);
    connect(bb, &QDialogButtonBox::accepted, &dlg, &QDialog::accept);
    connect(bb, &QDialogButtonBox::rejected, &dlg, &QDialog::reject);
    if (dlg.exec() != QDialog::Accepted) return;
    s.setValue("backend", backend->text().trimmed());
    s.setValue("mjpeg", mjpeg->text().trimmed());
    s.setValue("poll_ms", poll->value());
    loadSettings();
    m_profiles = QJsonArray();
    m_api.fetchStatus();
    m_api.fetchProfiles();
}

// Fans submenu: per fan an on/off toggle and preset percentages, plus the
// recommendation for the filament that is feeding (from /api/status fan_ctrl).
void TrayApp::buildFansMenu(QMenu *menu) {
    const QJsonObject ctrl = m_status.value("fan_ctrl").toObject();
    if (ctrl.isEmpty()) {
        menu->addAction("no fan data")->setEnabled(false);
        return;
    }
    const QJsonObject rec = ctrl.value("recommended").toObject();
    QAction *apply = menu->addAction(QString("Apply recommended: part %1% · aux %2% · chamber %3%")
        .arg(rec.value("part").toInt()).arg(rec.value("aux").toInt()).arg(rec.value("chamber").toInt()));
    apply->setToolTip(rec.value("source").toString());
    connect(apply, &QAction::triggered, this, [this] { m_api.applyRecommendedFans(); });
    menu->addAction("   " + rec.value("source").toString())->setEnabled(false);
    menu->addSeparator();
    struct F { const char *key; const char *name; };
    static const F fansDef[] = {{"part", "Part fan"}, {"aux", "Auxiliary fan"}, {"chamber", "Chamber fan"}};
    for (const F &f : fansDef) {
        const QJsonObject st = ctrl.value(f.key).toObject();
        const bool on = st.value("on").toBool();
        const int pct = st.value("pct").toInt();
        QMenu *sm = menu->addMenu(QString("%1 · %2").arg(f.name, on ? QString("%1%").arg(pct) : QString("off")));
        QAction *toggle = sm->addAction("On");
        toggle->setCheckable(true);
        toggle->setChecked(on);
        const QString key = f.key;
        connect(toggle, &QAction::triggered, this, [this, key](bool v) { m_api.setFans(QJsonObject{{key + "_on", v}}); });
        sm->addSeparator();
        for (int preset : {0, 25, 50, 75, 100}) {
            QAction *a = sm->addAction(QString("%1 %").arg(preset));
            a->setCheckable(true);
            a->setChecked(on ? pct == preset : preset == 0);
            connect(a, &QAction::triggered, this, [this, key, preset] { m_api.setFans(QJsonObject{{key, preset}}); });
        }
        sm->addSeparator();
        QAction *custom = sm->addAction("Custom…");
        connect(custom, &QAction::triggered, this, [this, key, pct, f] {
            bool ok = false;
            const int v = QInputDialog::getInt(nullptr, QString("%1 speed").arg(f.name), "Percent (0 = off)", pct, 0, 100, 5, &ok);
            if (ok) m_api.setFans(QJsonObject{{key, v}});
        });
    }
    const QString state = m_status.value("job").toObject().value("state").toString("standby");
    if (state != "printing" && state != "paused")
        menu->addAction("idle: a print job will take the fans back over")->setEnabled(false);
}
