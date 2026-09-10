#include "sensorswindow.h"
#include "sensorgraphic.h"

#include <QApplication>
#include <QClipboard>
#include <QHBoxLayout>
#include <QHeaderView>
#include <QJsonArray>
#include <QJsonDocument>
#include <QLabel>
#include <QPushButton>
#include <QRegularExpression>
#include <QTreeWidget>
#include <QVBoxLayout>

using namespace SensorGraphic;

static QString fmt(const QJsonValue &v) {
    switch (v.type()) {
    case QJsonValue::Double: {
        const double d = v.toDouble();
        return d == static_cast<long long>(d) ? QString::number(static_cast<long long>(d)) : QString::number(d, 'f', 3);
    }
    case QJsonValue::Bool: return v.toBool() ? "true" : "false";
    case QJsonValue::String: return v.toString();
    case QJsonValue::Null: case QJsonValue::Undefined: return "-";
    default: return QString::fromUtf8(QJsonDocument(v.isArray() ? QJsonDocument(v.toArray()) : QJsonDocument(v.toObject())).toJson(QJsonDocument::Compact));
    }
}

// Numeric value of a JSON field, accepting numbers-as-strings ("34.710000").
static bool asNumber(const QJsonValue &v, double *out) {
    if (v.isDouble()) { *out = v.toDouble(); return true; }
    if (v.isBool()) { *out = v.toBool() ? 1 : 0; return true; }
    if (v.isString()) {
        bool ok = false;
        const double d = v.toString().trimmed().toDouble(&ok);
        if (ok) { *out = d; return true; }
    }
    return false;
}

static const QRegularExpression kBoolKey("(?i)(^|_)(sw|ai|connect|enable|video|tfCard|powerLoss|detect|detector|support|elapse|selfTest|autoPid|status|light|filament_detected|is_)|Sw$|Detect$|Enable$|Support$|Status$");
static const QRegularExpression kPctKey("(?i)pct$|percent|progress|humidity|_pct");
static const QRegularExpression kTempKey("(?i)temp|temperature");

SensorsWindow::SensorsWindow(QWidget *parent) : QWidget(parent) {
    setWindowTitle("K2 sensors");
    resize(860, 680);
    auto *lay = new QVBoxLayout(this);
    m_tree = new QTreeWidget(this);
    m_tree->setColumnCount(3);
    m_tree->setHeaderLabels({"Sensor", "Value", "Graph"});
    m_tree->header()->setSectionResizeMode(0, QHeaderView::ResizeToContents);
    m_tree->header()->setSectionResizeMode(1, QHeaderView::Stretch);
    m_tree->header()->setSectionResizeMode(2, QHeaderView::Fixed);
    m_tree->header()->resizeSection(2, 150);
    m_tree->setAlternatingRowColors(true);
    m_tree->setUniformRowHeights(true);
    m_gfx = new SensorGraphicDelegate(m_tree);
    m_tree->setItemDelegate(m_gfx);
    lay->addWidget(m_tree, 1);
    auto *row = new QHBoxLayout;
    m_footer = new QLabel(this);
    row->addWidget(m_footer, 1);
    auto *copy = new QPushButton("Copy JSON", this);
    connect(copy, &QPushButton::clicked, this, [this] {
        QApplication::clipboard()->setText(QString::fromUtf8(QJsonDocument(m_last).toJson()));
    });
    row->addWidget(copy);
    lay->addLayout(row);
}

// Rebuilds the tree while keeping which top-level groups were expanded.
void SensorsWindow::update(const QJsonObject &st) {
    m_last = st;
    QSet<QString> expanded;
    for (int i = 0; i < m_tree->topLevelItemCount(); ++i) {
        auto *it = m_tree->topLevelItem(i);
        if (it->isExpanded()) expanded.insert(it->text(0));
    }
    const bool first = m_tree->topLevelItemCount() == 0;
    m_tree->clear();
    auto group = [&](const QString &name) {
        auto *g = new QTreeWidgetItem(m_tree, {name, "", ""});
        g->setExpanded(first ? name != "Device socket fields" && !name.startsWith("Klipper") : expanded.contains(name));
        return g;
    };
    auto kv = [](QTreeWidgetItem *p, const QString &k, const QString &v) { return new QTreeWidgetItem(p, {k, v, ""}); };
    auto setKind = [](QTreeWidgetItem *it, int kind, double v = 0, const QString &key = QString(), double target = 0, double max = 0) {
        it->setData(2, KindRole, kind);
        it->setData(2, ValueRole, v);
        it->setData(2, KeyRole, key);
        it->setData(2, TargetRole, target);
        it->setData(2, MaxRole, max);
    };
    auto spark = [&](QTreeWidgetItem *it, const QString &key, double v) {
        m_gfx->pushSample(key, v);
        setKind(it, Spark, v, key);
    };
    // Generic classifier for a loose key/value pair (Klipper objects and raw device fields).
    auto classify = [&](QTreeWidgetItem *it, const QString &key, const QJsonValue &val, const QJsonObject &ctx) {
        double d = 0;
        if (val.isBool()) { setKind(it, Bool, val.toBool() ? 1 : 0); return; }
        if (val.isString() && (val.toString() == "None" || val.toString().isEmpty())) { setKind(it, Text); return; }
        if (!asNumber(val, &d)) {
            // strings/arrays: color lists get a swatch, everything else a tag
            if (val.isArray() && key.contains("color", Qt::CaseInsensitive)) {
                QStringList cols;
                for (const QJsonValue &c : val.toArray()) {
                    QString s = c.toString();
                    if (s.size() == 7 && s.startsWith('0')) s = "#" + s.mid(1); // "0ffffff" -> #ffffff
                    if (s.startsWith('#')) cols << s;
                }
                if (!cols.isEmpty()) {
                    it->setData(2, KindRole, Swatch);
                    it->setData(2, ColorsRole, cols);
                    return;
                }
            }
            setKind(it, Text);
            return;
        }
        const bool zeroOne = (d == 0 || d == 1);
        if (zeroOne && kBoolKey.match(key).hasMatch()) { setKind(it, Bool, d); return; }
        if (kPctKey.match(key).hasMatch() && d >= 0 && d <= 100) {
            setKind(it, Percent, d);
            it->setData(2, AuxRole, key.contains("fan", Qt::CaseInsensitive) ? 1.0 : 0.0);
            return;
        }
        if (kTempKey.match(key).hasMatch() && !key.contains("max", Qt::CaseInsensitive) && !key.startsWith("target")) {
            double mx = 300, target = 0;
            const QString k = key.toLower();
            if (k.contains("bed")) mx = ctx.value("maxBedTemp").toDouble(120);
            else if (k.contains("box") || k.contains("chamber")) mx = ctx.value("maxBoxTemp").toDouble(60);
            else if (k.contains("nozzle") || k.contains("extruder")) mx = ctx.value("maxNozzleTemp").toDouble(300);
            else if (k.contains("mcu") || k.contains("cpu")) mx = 100;
            asNumber(ctx.value("target" + key.left(1).toUpper() + key.mid(1)), &target);
            asNumber(ctx.value("target"), &target);
            const QString hk = it->parent() ? it->parent()->text(0) + "/" + key : key;
            m_gfx->pushSample(hk, d);
            setKind(it, Temp, d, hk, target, mx);
            return;
        }
        const QString hk = (it->parent() ? it->parent()->text(0) + "/" : QString()) + key;
        spark(it, hk, d);
    };

    auto *t = group("Temperatures");
    const QJsonObject temps = st.value("temps").toObject();
    for (auto it = temps.begin(); it != temps.end(); ++it) {
        const QJsonObject o = it.value().toObject();
        auto *row = kv(t, it.key(), QString("%1 °C  →  %2 °C").arg(o.value("actual").toDouble(), 0, 'f', 1).arg(o.value("target").toDouble(), 0, 'f', 0));
        m_gfx->pushSample("temps/" + it.key(), o.value("actual").toDouble());
        setKind(row, Temp, o.value("actual").toDouble(), "temps/" + it.key(), o.value("target").toDouble(), o.value("max").toDouble());
    }
    auto *f = group("Fans / motion");
    const QJsonObject fans = st.value("fans").toObject();
    for (auto it = fans.begin(); it != fans.end(); ++it) {
        auto *row = kv(f, it.key() + " fan", QString::number(it.value().toInt()) + " %");
        setKind(row, Percent, it.value().toDouble());
        row->setData(2, AuxRole, 1.0);
    }
    setKind(kv(f, "speed factor", QString::number(st.value("speed_pct").toInt()) + " %"), Factor, st.value("speed_pct").toDouble());
    setKind(kv(f, "flow factor", QString::number(st.value("flow_pct").toInt()) + " %"), Factor, st.value("flow_pct").toDouble());
    {
        auto *pos = kv(f, "position", st.value("position").toString());
        static const QRegularExpression re("X:\\s*(-?[0-9.]+)\\s*Y:\\s*(-?[0-9.]+)\\s*Z:\\s*(-?[0-9.]+)");
        const auto m = re.match(st.value("position").toString());
        pos->setData(2, KindRole, Axis);
        pos->setData(2, VectorRole, QVariantList{m.hasMatch() ? m.captured(1).toDouble() : 0.0,
                                                 m.hasMatch() ? m.captured(2).toDouble() : 0.0,
                                                 m.hasMatch() ? m.captured(3).toDouble() : 0.0});
    }
    setKind(kv(f, "light", st.value("light").toBool() ? "on" : "off"), Bool, st.value("light").toBool() ? 1 : 0);

    auto *c = group("Filament system");
    const QJsonObject cfs = st.value("cfs").toObject();
    setKind(kv(c, "connected", cfs.value("connected").toBool() ? "yes" : "no"), Bool, cfs.value("connected").toBool() ? 1 : 0);
    setKind(kv(c, "feeding", cfs.value("active").toString("-")), Bool, cfs.value("active").toString().isEmpty() ? 0 : 1);
    for (const QJsonValue &bv : cfs.value("boxes").toArray()) {
        const QJsonObject b = bv.toObject();
        const bool unit = b.value("type").toInt() == 0;
        auto *bi = new QTreeWidgetItem(c, {b.value("name").toString(), unit
            ? QString("%1 °C · %2 % RH").arg(b.value("temp").toDouble(), 0, 'f', 0).arg(b.value("humidity").toDouble(), 0, 'f', 0) : "", ""});
        bi->setExpanded(true);
        if (unit) {
            bi->setData(2, KindRole, Box);
            bi->setData(2, ValueRole, b.value("temp").toDouble());
            bi->setData(2, AuxRole, b.value("humidity").toDouble());
            bi->setData(2, Aux2Role, 60.0);
        } else {
            setKind(bi, Bool, b.value("state").toInt() != 0 || !b.value("slots").toArray().isEmpty());
        }
        for (const QJsonValue &sv : b.value("slots").toArray()) {
            const QJsonObject s = sv.toObject();
            auto *row = kv(bi, s.value("label").toString(), QString("%1 %2 (%3) %4-%5 °C · PA %6 · %7 %%8")
                .arg(s.value("vendor").toString(), s.value("name").toString(), s.value("type").toString())
                .arg(s.value("min_temp").toDouble(), 0, 'f', 0).arg(s.value("max_temp").toDouble(), 0, 'f', 0)
                .arg(s.value("pressure").toDouble()).arg(s.value("percent").toInt())
                .arg(s.value("selected").toBool() ? " · FEEDING" : ""));
            QStringList cols;
            for (const QJsonValue &cv : s.value("colors").toArray()) cols << cv.toString();
            if (cols.isEmpty()) cols << s.value("color").toString("#888888");
            row->setData(2, KindRole, Swatch);
            row->setData(2, ColorsRole, cols);
        }
    }
    const QJsonObject sensors = st.value("sensors").toObject();
    QStringList names = sensors.keys();
    names.sort();
    auto *k = group(QString("Klipper objects (%1)").arg(names.size()));
    for (const QString &n : names) {
        const QJsonObject o = sensors.value(n).toObject();
        auto *oi = new QTreeWidgetItem(k, {n, "", ""});
        // Object-level graphic: temperature if it has one, else a LED for "connect"-like state, else tag.
        double d = 0;
        if (asNumber(o.value("temperature"), &d)) {
            double target = 0, mx = 300;
            asNumber(o.value("target"), &target);
            const QString ln = n.toLower();
            if (ln.contains("bed")) mx = 120; else if (ln.contains("chamber") || ln.contains("box")) mx = 60; else if (ln.contains("mcu") || ln.contains("host") || ln.contains("cpu")) mx = 100;
            m_gfx->pushSample("obj/" + n, d);
            setKind(oi, Temp, d, "obj/" + n, target, mx);
        } else if (o.contains("state")) {
            const QJsonValue sv = o.value("state");
            setKind(oi, Bool, sv.isString() ? (sv.toString() == "connect" || sv.toString() == "ready" || sv.toString() == "on") : sv.toDouble() != 0);
        } else if (o.contains("speed")) {
            double sp = 0; asNumber(o.value("speed"), &sp);
            setKind(oi, Percent, sp <= 1.0 ? sp * 100 : sp);
            oi->setData(2, AuxRole, 1.0);
        } else if (o.contains("value")) {
            double vv = 0; asNumber(o.value("value"), &vv);
            setKind(oi, Bool, vv != 0);
        } else {
            setKind(oi, Text);
        }
        for (auto it = o.begin(); it != o.end(); ++it) {
            const QString key = it.key();
            const QJsonValue val = it.value();
            // nested per-unit objects (box.T1..T4): one child per field
            if (val.isObject()) {
                auto *sub = new QTreeWidgetItem(oi, {key, "", ""});
                const QJsonObject so = val.toObject();
                const bool present = so.value("state").toString() != "None" && so.value("state").toString() != "";
                setKind(sub, Bool, present);
                for (auto jt = so.begin(); jt != so.end(); ++jt) {
                    auto *leaf = kv(sub, jt.key(), fmt(jt.value()));
                    classify(leaf, jt.key(), jt.value(), so);
                }
                continue;
            }
            auto *leaf = kv(oi, key, fmt(val));
            if (key == "speed" || key == "power") {
                double sp = 0; asNumber(val, &sp);
                setKind(leaf, Percent, sp <= 1.0 ? sp * 100 : sp);
                leaf->setData(2, AuxRole, key == "speed" ? 1.0 : 0.0);
            } else if (key == "progress") {
                double pr = 0; asNumber(val, &pr);
                setKind(leaf, Percent, pr <= 1.0 ? pr * 100 : pr);
            } else if (key == "target") {
                double tg = 0; asNumber(val, &tg);
                setKind(leaf, Percent, 0); // placeholder replaced below
                leaf->setData(2, KindRole, tg > 0 ? Temp : Text);
                leaf->setData(2, ValueRole, tg);
                leaf->setData(2, MaxRole, 300.0);
            } else {
                classify(leaf, key, val, o);
            }
        }
    }
    const QJsonObject dev = st.value("device").toObject();
    QStringList dk = dev.keys();
    dk.sort();
    auto *d = group("Device socket fields");
    for (const QString &n : dk) {
        auto *leaf = kv(d, n, fmt(dev.value(n)));
        classify(leaf, n, dev.value(n), dev);
    }

    const QJsonObject src = st.value("sources").toObject();
    m_footer->setText(QString("Moonraker %1 · device socket %2 · updated %3")
        .arg(src.value("moonraker").toBool() ? "ok" : "down", src.value("cxws").toBool() ? "ok" : "down",
             st.value("updated_at").toString().left(19).replace('T', ' ')));
    m_tree->viewport()->update();
}
