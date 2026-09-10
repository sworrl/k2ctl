#pragma once
#include <QHash>
#include <QStyledItemDelegate>
#include <QVector>

// Per-row graphic painted in the "Graph" column of the sensors monitor.
// Rows describe themselves through item data roles (see SensorGraphic::Role);
// the delegate keeps a short history per row key for sparklines.
namespace SensorGraphic {
enum Kind { None = 0, Temp, Percent, Factor, Bool, Swatch, Spark, Axis, Text, Box };
enum Role {
    KindRole = Qt::UserRole + 1,
    ValueRole,   // double
    TargetRole,  // double (Temp: target, Factor: nominal 100)
    MaxRole,     // double (scale)
    KeyRole,     // QString history key
    ColorsRole,  // QStringList of #rrggbb (Swatch)
    AuxRole,     // double (Box: humidity %; Axis: unused)
    Aux2Role,    // double (Box: temp max)
    VectorRole,  // QVariantList of 3 doubles (Axis: x,y,z)
};
}

class SensorGraphicDelegate : public QStyledItemDelegate {
    Q_OBJECT
public:
    using QStyledItemDelegate::QStyledItemDelegate;
    void paint(QPainter *p, const QStyleOptionViewItem &opt, const QModelIndex &idx) const override;
    QSize sizeHint(const QStyleOptionViewItem &opt, const QModelIndex &idx) const override;

    // Record a sample for a sparkline key; keeps the last `keep` values.
    void pushSample(const QString &key, double v, int keep = 60);
    const QVector<double> &history(const QString &key) const;

private:
    QHash<QString, QVector<double>> m_hist;
    QVector<double> m_empty;
};
