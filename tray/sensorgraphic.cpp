#include "sensorgraphic.h"

#include <QLinearGradient>
#include <QPainter>
#include <QPainterPath>
#include <QtMath>

using namespace SensorGraphic;

static const QColor kMuted("#6b7583");
static const QColor kLine("#3a434f");
static const QColor kOk("#3ddc84");
static const QColor kWarn("#ffb648");
static const QColor kBad("#ff5c5c");
static const QColor kAccent("#4fb3ff");

void SensorGraphicDelegate::pushSample(const QString &key, double v, int keep) {
    auto &h = m_hist[key];
    h.push_back(v);
    while (h.size() > keep) h.pop_front();
}

const QVector<double> &SensorGraphicDelegate::history(const QString &key) const {
    auto it = m_hist.find(key);
    return it == m_hist.end() ? m_empty : it.value();
}

QSize SensorGraphicDelegate::sizeHint(const QStyleOptionViewItem &opt, const QModelIndex &idx) const {
    QSize s = QStyledItemDelegate::sizeHint(opt, idx);
    s.setHeight(qMax(s.height(), 22));
    if (idx.column() == 2) s.setWidth(150);
    return s;
}

// Heat color: cold blue -> green -> amber -> red as ratio goes 0..1.
static QColor heat(double r) {
    r = qBound(0.0, r, 1.0);
    if (r < 0.33) return QColor::fromHsvF(0.58 - 0.25 * (r / 0.33), 0.7, 0.95);
    if (r < 0.66) return QColor::fromHsvF(0.33 - 0.22 * ((r - 0.33) / 0.33), 0.8, 0.95);
    return QColor::fromHsvF(0.11 - 0.11 * ((r - 0.66) / 0.34), 0.9, 0.95);
}

static void drawSpark(QPainter *p, const QRectF &r, const QVector<double> &h, const QColor &c, double lo = 0, double hi = 0) {
    if (h.size() < 2) {
        p->setPen(QPen(kLine, 1));
        p->drawLine(r.left(), r.center().y(), r.right(), r.center().y());
        return;
    }
    double mn = lo, mx = hi;
    if (mn == mx) {
        mn = *std::min_element(h.begin(), h.end());
        mx = *std::max_element(h.begin(), h.end());
        if (qFuzzyCompare(mn, mx)) { mn -= 1; mx += 1; }
        const double pad = (mx - mn) * 0.1;
        mn -= pad; mx += pad;
    }
    QPainterPath path;
    const double dx = r.width() / double(qMax(1, h.size() - 1));
    for (int i = 0; i < h.size(); ++i) {
        const double y = r.bottom() - (h[i] - mn) / (mx - mn) * r.height();
        if (i == 0) path.moveTo(r.left(), y); else path.lineTo(r.left() + i * dx, y);
    }
    QPainterPath fill = path;
    fill.lineTo(r.right(), r.bottom());
    fill.lineTo(r.left(), r.bottom());
    QColor fc = c; fc.setAlpha(45);
    p->fillPath(fill, fc);
    p->setPen(QPen(c, 1.3));
    p->drawPath(path);
    p->setBrush(c);
    p->setPen(Qt::NoPen);
    p->drawEllipse(path.currentPosition(), 1.8, 1.8);
}

static void drawBar(QPainter *p, const QRectF &r, double ratio, const QColor &c, double tick = -1) {
    p->setPen(Qt::NoPen);
    p->setBrush(QColor(255, 255, 255, 18));
    p->drawRoundedRect(r, 3, 3);
    QRectF f = r; f.setWidth(r.width() * qBound(0.0, ratio, 1.0));
    if (f.width() > 0.5) { p->setBrush(c); p->drawRoundedRect(f, 3, 3); }
    if (tick >= 0) {
        const double x = r.left() + r.width() * qBound(0.0, tick, 1.0);
        p->setPen(QPen(Qt::white, 1.5));
        p->drawLine(QPointF(x, r.top() - 2), QPointF(x, r.bottom() + 2));
    }
}

static void drawFan(QPainter *p, const QRectF &r, double pct) {
    const QPointF c = r.center();
    const double R = r.height() / 2.0;
    const QColor col = pct > 0 ? kAccent : kMuted;
    // hub + three blades
    p->setPen(Qt::NoPen);
    p->setBrush(col);
    for (int i = 0; i < 3; ++i) {
        p->save();
        p->translate(c);
        p->rotate(i * 120.0);
        QPainterPath b;
        b.moveTo(0, 0);
        b.cubicTo(R * 0.9, -R * 0.2, R * 0.9, -R * 0.9, R * 0.15, -R * 0.75);
        b.closeSubpath();
        p->drawPath(b);
        p->restore();
    }
    p->drawEllipse(c, R * 0.22, R * 0.22);
    // arc showing %
    p->setBrush(Qt::NoBrush);
    p->setPen(QPen(kLine, 2));
    QRectF a(c.x() - R - 1, c.y() - R - 1, 2 * R + 2, 2 * R + 2);
    p->drawArc(a, 0, 360 * 16);
    if (pct > 0) {
        p->setPen(QPen(col, 2));
        p->drawArc(a, 90 * 16, int(-360 * 16 * qBound(0.0, pct / 100.0, 1.0)));
    }
}

static void drawLed(QPainter *p, const QRectF &r, bool on) {
    const QPointF c(r.left() + 8, r.center().y());
    p->setPen(Qt::NoPen);
    if (on) {
        QColor glow = kOk; glow.setAlpha(70);
        p->setBrush(glow);
        p->drawEllipse(c, 7, 7);
    }
    p->setBrush(on ? kOk : QColor("#3a434f"));
    p->drawEllipse(c, 4.5, 4.5);
    p->setPen(QPen(on ? kOk.lighter(140) : kMuted, 1));
    p->setBrush(Qt::NoBrush);
    p->drawEllipse(c, 4.5, 4.5);
}

static void drawSwatch(QPainter *p, const QRectF &r, const QStringList &colors) {
    QRectF s(r.left(), r.top() + 2, 44, r.height() - 4);
    p->setPen(QPen(kLine, 1));
    if (colors.size() > 1) {
        QLinearGradient g(s.topLeft(), s.topRight());
        for (int i = 0; i < colors.size(); ++i) g.setColorAt(double(i) / (colors.size() - 1), QColor(colors[i]));
        p->setBrush(g);
    } else {
        p->setBrush(colors.isEmpty() ? QColor(kMuted) : QColor(colors[0]));
    }
    p->drawRoundedRect(s, 4, 4);
}

static void drawAxis(QPainter *p, const QRectF &r, const QVariantList &v) {
    static const QColor cols[3] = {QColor("#ff5c5c"), QColor("#3ddc84"), QColor("#4fb3ff")};
    static const char *lbl[3] = {"X", "Y", "Z"};
    const double h = (r.height() - 2) / 3.0;
    p->setFont(QFont(p->font().family(), 6));
    for (int i = 0; i < 3 && i < v.size(); ++i) {
        QRectF row(r.left() + 10, r.top() + 1 + i * h, r.width() - 10, h - 1.5);
        p->setPen(cols[i]);
        p->drawText(QRectF(r.left(), row.top() - 1, 9, h + 2), Qt::AlignVCenter | Qt::AlignLeft, lbl[i]);
        static const double axisMax[3] = {262.0, 262.0, 270.0}; // Creality K2 travel
        drawBar(p, row, v[i].toDouble() / axisMax[i], cols[i]);
    }
}

static void drawTag(QPainter *p, const QRectF &r) {
    QPainterPath t;
    const double y = r.center().y();
    t.moveTo(r.left() + 1, y - 5);
    t.lineTo(r.left() + 11, y - 5);
    t.lineTo(r.left() + 16, y);
    t.lineTo(r.left() + 11, y + 5);
    t.lineTo(r.left() + 1, y + 5);
    t.closeSubpath();
    p->setPen(QPen(kMuted, 1));
    p->setBrush(QColor(255, 255, 255, 14));
    p->drawPath(t);
    p->setBrush(kMuted);
    p->setPen(Qt::NoPen);
    p->drawEllipse(QPointF(r.left() + 5, y), 1.3, 1.3);
}

void SensorGraphicDelegate::paint(QPainter *p, const QStyleOptionViewItem &opt, const QModelIndex &idx) const {
    if (idx.column() != 2) { QStyledItemDelegate::paint(p, opt, idx); return; }
    // background/selection as usual, no text
    QStyleOptionViewItem o = opt;
    o.text.clear();
    QStyledItemDelegate::paint(p, o, idx);

    const int kind = idx.data(KindRole).toInt();
    if (kind == None) return;
    QRectF r = QRectF(opt.rect).adjusted(6, 3, -6, -3);
    p->save();
    p->setRenderHint(QPainter::Antialiasing, true);
    const double v = idx.data(ValueRole).toDouble();
    const double mx = idx.data(MaxRole).toDouble();
    const QString key = idx.data(KeyRole).toString();

    switch (kind) {
    case Temp: {
        const double target = idx.data(TargetRole).toDouble();
        const double scale = mx > 0 ? mx : 300;
        QRectF bar(r.left(), r.center().y() - 4, 62, 8);
        drawBar(p, bar, v / scale, heat(v / scale), target > 0 ? target / scale : -1);
        drawSpark(p, QRectF(r.left() + 70, r.top(), r.width() - 70, r.height()), history(key), heat(v / scale));
        break;
    }
    case Percent: {
        const bool fan = idx.data(AuxRole).toDouble() != 0;
        double x = r.left();
        if (fan) { drawFan(p, QRectF(r.left(), r.top(), r.height(), r.height()), v); x += r.height() + 8; }
        QRectF bar(x, r.center().y() - 4, r.right() - x - 2, 8);
        drawBar(p, bar, v / 100.0, v > 0 ? kAccent : kMuted);
        break;
    }
    case Factor: {
        // 0..200 %, tick at 100 %
        QRectF bar(r.left(), r.center().y() - 4, r.width() - 4, 8);
        drawBar(p, bar, v / 200.0, qAbs(v - 100) < 0.5 ? kOk : kWarn, 0.5);
        break;
    }
    case Bool:
        drawLed(p, r, v != 0);
        break;
    case Swatch:
        drawSwatch(p, r, idx.data(ColorsRole).toStringList());
        break;
    case Spark: {
        const auto &h = history(key);
        drawSpark(p, r, h, kAccent);
        break;
    }
    case Axis:
        drawAxis(p, r, idx.data(VectorRole).toList());
        break;
    case Box: {
        // temperature bar (scale 0..60) over humidity bar (0..100)
        const double hum = idx.data(AuxRole).toDouble();
        const double tmax = idx.data(Aux2Role).toDouble() > 0 ? idx.data(Aux2Role).toDouble() : 60;
        QRectF t(r.left(), r.top() + 1, r.width() - 4, 6), hbar(r.left(), r.bottom() - 7, r.width() - 4, 6);
        drawBar(p, t, v / tmax, heat(v / tmax));
        drawBar(p, hbar, hum / 100.0, hum > 50 ? kWarn : kAccent);
        break;
    }
    case Text:
    default:
        drawTag(p, r);
        break;
    }
    p->restore();
}
