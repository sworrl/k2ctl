#include "costwindow.h"

#include <QDir>
#include <QDragEnterEvent>
#include <QDropEvent>
#include <QFile>
#include <QFileDialog>
#include <QFileInfo>
#include <QHBoxLayout>
#include <QColor>
#include <QImage>
#include <QJsonArray>
#include <QJsonDocument>
#include <QLabel>
#include <QMimeData>
#include <QNetworkReply>
#include <QProcess>
#include <QPushButton>
#include <QRegularExpression>
#include <QSettings>
#include <QStandardPaths>
#include <QTextBrowser>
#include <QVBoxLayout>
#include <QTimer>
#include <QApplication>

static QString money(double v, const QString &cur) {
    return cur + QString::number(v, 'f', v > 0 && v < 1 ? 3 : 2);
}
static QString grams(double g) {
    return g >= 1000 ? QString::number(g / 1000, 'f', 2) + " kg" : QString::number(g, 'f', g < 10 ? 1 : 0) + " g";
}
static QString hm(double s) {
    if (s <= 0) return "-";
    const int m = int(s / 60 + 0.5);
    return QString("%1h %2m").arg(m / 60).arg(m % 60, 2, 10, QChar('0'));
}

CostWindow::CostWindow(QWidget *parent) : QWidget(parent) {
    setWindowTitle("K2 print cost");
    setAcceptDrops(true);
    resize(620, 720);
    auto *v = new QVBoxLayout(this);
    auto *row = new QHBoxLayout;
    auto *pick = new QPushButton("Add files…", this);
    m_clear = new QPushButton("Clear", this);
    m_status = new QLabel("Pick a sliced .gcode or a Creality Print .3mf, or drop files here.", this);
    m_status->setWordWrap(true);
    row->addWidget(pick);
    row->addWidget(m_clear);
    row->addWidget(m_status, 1);
    v->addLayout(row);
    m_view = new QTextBrowser(this);
    m_view->setOpenLinks(false);
    v->addWidget(m_view, 1);
    connect(pick, &QPushButton::clicked, this, &CostWindow::browse);
    connect(m_clear, &QPushButton::clicked, this, [this] {
        m_items.clear();
        for (const QString &f : QDir(m_thumbs.path()).entryList({"thumb-*.png"})) QFile::remove(m_thumbs.filePath(f));
        render();
    });
    m_nam.setTransferTimeout(30000);
}

void CostWindow::browse() {
    show();
    raise();
    activateWindow();
    QSettings s("k2ctl", "tray");
    const QString dir = s.value("cost_dir", QStandardPaths::writableLocation(QStandardPaths::HomeLocation)).toString();
    const QStringList files = QFileDialog::getOpenFileNames(this, "Files to price", dir,
        "Sliced prints (*.gcode *.3mf);;G-code (*.gcode);;Creality Print projects (*.3mf);;All files (*)");
    if (files.isEmpty()) return;
    s.setValue("cost_dir", QFileInfo(files.first()).absolutePath());
    addFiles(files);
}

void CostWindow::dragEnterEvent(QDragEnterEvent *e) {
    if (e->mimeData()->hasUrls()) e->acceptProposedAction();
}

void CostWindow::dropEvent(QDropEvent *e) {
    QStringList paths;
    for (const QUrl &u : e->mimeData()->urls())
        if (u.isLocalFile()) paths << u.toLocalFile();
    addFiles(paths);
}

void CostWindow::addFiles(const QStringList &paths) {
    for (const QString &p : paths) {
        const QString ext = QFileInfo(p).suffix().toLower();
        if (ext == "gcode") estimateGcode(p, p, QFileInfo(p).fileName());
        else if (ext == "3mf") handle3mf(p);
        else m_items.append({p, QFileInfo(p).fileName(), {}, "not a .gcode or .3mf; slice it in Creality Print first"});
    }
    render();
}

void CostWindow::setBusy(const QString &msg) {
    m_status->setText(m_pending > 0 ? msg : QString("%1 file%2 priced.").arg(m_items.size()).arg(m_items.size() == 1 ? "" : "s"));
}

// A .3mf saved after slicing carries Metadata/plate_N.gcode; use those. Otherwise
// slice it headless (no display, so it cannot touch an open Creality Print window).
void CostWindow::handle3mf(const QString &path) {
    const QString name = QFileInfo(path).fileName();
    auto *tmp = new QTemporaryDir;
    m_tmp << tmp;
    QProcess list;
    list.start("unzip", {"-Z1", path});
    list.waitForFinished(15000);
    QStringList plates;
    for (const QString &l : QString::fromUtf8(list.readAllStandardOutput()).split('\n'))
        if (QRegularExpression("^Metadata/plate_\\d+\\.gcode$").match(l.trimmed()).hasMatch()) plates << l.trimmed();
    if (!plates.isEmpty()) {
        for (const QString &pl : plates) {
            const QString out = tmp->filePath(QFileInfo(pl).fileName());
            QProcess x;
            x.setStandardOutputFile(out);
            x.start("unzip", {"-p", path, pl});
            x.waitForFinished(60000);
            estimateGcode(out, path, QString("%1, %2").arg(name, QFileInfo(pl).baseName().replace('_', ' ')));
        }
        return;
    }
    QSettings s("k2ctl", "tray");
    const QString slicer = s.value("slicer", "/usr/bin/CrealityPrint").toString();
    if (!QFileInfo(slicer).isExecutable()) {
        m_items.append({path, name, {}, "this project is not sliced and Creality Print was not found at " + slicer});
        return;
    }
    auto *p = new QProcess(this);
    QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
    env.remove("DISPLAY");
    env.remove("WAYLAND_DISPLAY");
    p->setProcessEnvironment(env);
    ++m_pending;
    setBusy("Slicing " + name + "…");
    // The Creality Print command line crashes or hangs on multicolour projects; give up
    // after two minutes rather than leave a slicer running.
    auto *limit = new QTimer(p);
    limit->setSingleShot(true);
    connect(limit, &QTimer::timeout, p, [p] { p->kill(); });
    limit->start(120000);
    connect(p, &QProcess::finished, this, [this, p, tmp, path, name](int code, QProcess::ExitStatus st) {
        p->deleteLater();
        --m_pending;
        QDir d(tmp->path());
        const QStringList gs = d.entryList({"plate_*.gcode"}, QDir::Files, QDir::Name);
        if (gs.isEmpty()) {
            m_items.append({path, name, {}, st == QProcess::CrashExit || code != 0
                ? QString("Creality Print could not slice this headless (exit %1). Its command line fails on multicolour projects; "
                          "slice it in Creality Print, export the plate gcode, and pick that file.").arg(code)
                : QString("slicing produced no gcode")});
            render();
            return;
        }
        for (const QString &g : gs)
            estimateGcode(d.filePath(g), path, gs.size() > 1 ? QString("%1, %2").arg(name, QFileInfo(g).baseName().replace('_', ' ')) : name);
    });
    p->start(slicer, {"--slice", "0", "--outputdir", tmp->path(), path});
}

// Sends the first 600 kB and last 80 kB (thumbnail, filament and time lines) to the backend.
void CostWindow::estimateGcode(const QString &gcodePath, const QString &source, const QString &label) {
    QFile f(gcodePath);
    if (!f.open(QIODevice::ReadOnly)) {
        m_items.append({source, label, {}, f.errorString()});
        return;
    }
    const qint64 n = f.size();
    const QByteArray head = f.read(600000);
    QByteArray tail;
    if (n > 600000) {
        f.seek(qMax<qint64>(600000, n - 80000));
        tail = f.readAll();
    }
    if (m_base.isEmpty()) {
        m_items.append({source, label, {}, "no backend URL; set it under Settings in the tray menu"});
        return;
    }
    QUrl u = m_base;
    u.setPath("/api/costs/estimate");
    QNetworkRequest req(u);
    req.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    const QJsonObject body{{"name", QFileInfo(label).fileName()}, {"head", QString::fromUtf8(head)}, {"tail", QString::fromUtf8(tail)}};
    ++m_pending;
    setBusy("Pricing " + label + "…");
    const int idx = m_items.size();
    m_items.append({source, label, {}, {}});
    QNetworkReply *r = m_nam.post(req, QJsonDocument(body).toJson(QJsonDocument::Compact));
    connect(r, &QNetworkReply::finished, this, [this, r, idx] {
        r->deleteLater();
        --m_pending;
        const QJsonDocument doc = QJsonDocument::fromJson(r->readAll());
        if (idx < m_items.size()) {
            if (r->error() != QNetworkReply::NoError) m_items[idx].error = doc.object().value("error").toString(r->errorString());
            else {
                QJsonObject est = doc.object();
                // A headless slice renders no thumbnail; the project keeps its own plate preview.
                const QString src = m_items[idx].source;
                if (est.value("thumb").toString().isEmpty() && src.endsWith(".3mf", Qt::CaseInsensitive)) {
                    const QRegularExpressionMatch m = QRegularExpression("plate (\\d+)$").match(m_items[idx].label);
                    QProcess x;
                    x.start("unzip", {"-p", src, QString("Metadata/plate_%1.png").arg(m.hasMatch() ? m.captured(1) : "1")});
                    x.waitForFinished(15000);
                    const QByteArray png = x.readAllStandardOutput();
                    if (png.startsWith("\x89PNG")) est["thumb"] = QString::fromLatin1(png.toBase64());
                }
                m_items[idx].est = est;
            }
        }
        render();
    });
}

void CostWindow::render() {
    setBusy(m_status->text());
    const QString css = "<style>td{padding:2px 8px 2px 0;} .big{font-size:20pt;font-weight:bold;} .dim{color:#8fa4ba;} .err{color:#f87171;}</style>";
    QString html;
    double tc = 0, tf = 0, te = 0, tg = 0, ts = 0;
    QString cur = "$";
    int ok = 0;
    for (int i = 0; i < m_items.size(); ++i) {
        const Item &it = m_items[i];
        html += "<hr>";
        if (!it.error.isEmpty()) {
            html += QString("<p><b>%1</b><br><span class='err'>%2</span></p>").arg(it.label.toHtmlEscaped(), it.error.toHtmlEscaped());
            continue;
        }
        if (it.est.isEmpty()) {
            html += QString("<p><b>%1</b><br><span class='dim'>working…</span></p>").arg(it.label.toHtmlEscaped());
            continue;
        }
        const QJsonObject &e = it.est;
        cur = e.value("currency").toString("$");
        const QString thumb = e.value("thumb").toString();
        QString img;
        if (!thumb.isEmpty() && m_thumbs.isValid()) {
            const QString f = m_thumbs.filePath(QString("thumb-%1.png").arg(i));
            if (!QFileInfo::exists(f))
                QImage::fromData(QByteArray::fromBase64(thumb.toLatin1())).scaled(150, 150, Qt::KeepAspectRatio, Qt::SmoothTransformation).save(f);
            img = QString("<img src='%1' width='150' height='150'>").arg(QUrl::fromLocalFile(f).toString());
        }
        QString mats;
        for (const QJsonValue &mv : e.value("materials").toArray()) {
            const QJsonObject m = mv.toObject();
            QString col = m.value("color").toString();
            if (col.isEmpty()) col = "#888888";
            // A white or near-white spool gets a hollow gray ring so it shows on a light window.
            const QString dot = QColor(col).lightnessF() > 0.85 ? "<span style='color:#888888'>&#9675;</span>"
                                                                  : QString("<span style='color:%1'>&#9679;</span>").arg(col);
            mats += QString("<tr><td>%1 %2</td><td>%3</td><td class='dim'>at %4/kg</td><td>%5</td></tr>")
                .arg(dot, m.value("type").toString().toHtmlEscaped(), grams(m.value("g").toDouble()),
                     money(m.value("price_kg").toDouble(), cur), money(m.value("cost").toDouble(), cur));
        }
        QString warn;
        for (const QJsonValue &w : e.value("warnings").toArray()) warn += "<br><span class='err'>" + w.toString().toHtmlEscaped() + "</span>";
        html += QString("<table><tr><td valign='top'>%1</td><td valign='top'>"
                        "<b>%2</b><br><span class='big'>%3</span><br>"
                        "filament %4 (%5) &nbsp; electricity %6 (%7 kWh)<br>"
                        "<span class='dim'>about %8 on the printer (slicer says %9; this K2 runs %10 of that over %11 jobs) · nozzle %12° bed %13°</span>"
                        "<table>%14</table>%15</td></tr></table>")
            .arg(img, it.label.toHtmlEscaped(), money(e.value("cost").toDouble(), cur),
                 money(e.value("filament_cost").toDouble(), cur), grams(e.value("g").toDouble()),
                 money(e.value("energy_cost").toDouble(), cur), QString::number(e.value("kwh").toDouble(), 'f', 2),
                 hm(e.value("total_s").toDouble()), hm(e.value("slicer_s").toDouble()),
                 QString::number(e.value("time_factor").toDouble() * 100, 'f', 0) + "%", QString::number(e.value("factor_jobs").toInt()),
                 QString::number(e.value("nozzle_c").toDouble(), 'f', 0), QString::number(e.value("bed_c").toDouble(), 'f', 0),
                 mats, warn);
        tc += e.value("cost").toDouble();
        tf += e.value("filament_cost").toDouble();
        te += e.value("energy_cost").toDouble();
        tg += e.value("g").toDouble();
        ts += e.value("total_s").toDouble();
        ++ok;
    }
    QString top;
    if (ok > 1)
        top = QString("<p><span class='big'>%1</span> for %2 prints<br>filament %3 (%4) &nbsp; electricity %5 &nbsp; about %6 on the printer</p>")
            .arg(money(tc, cur)).arg(ok).arg(money(tf, cur), grams(tg), money(te, cur), hm(ts));
    if (m_items.isEmpty())
        top = "<p class='dim'>Prices, power figures and the time factor come from the printer's k2ctl "
              "(set them with Prices in the dashboard's print library).</p>";
    m_view->setHtml(css + top + html);
    // K2CTL_COST_GRAB=file.png saves the window once everything is priced (README screenshots).
    const QString grab = qEnvironmentVariable("K2CTL_COST_GRAB");
    if (!grab.isEmpty() && m_pending == 0 && !m_items.isEmpty())
        QTimer::singleShot(800, this, [this, grab] { this->grab().save(grab); qApp->quit(); });
}
