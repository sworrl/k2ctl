#pragma once
#include <QJsonObject>
#include <QWidget>

class QTreeWidget;
class QLabel;
class SensorGraphicDelegate;

// Verbose monitor: every temperature, fan, CFS reading, Klipper sensor object
// and raw device-socket field, refreshed on every status update. Every row
// carries a live graphic (gauge, sparkline, fan arc, LED, swatch…) in the
// third column, painted by SensorGraphicDelegate.
class SensorsWindow : public QWidget {
    Q_OBJECT
public:
    explicit SensorsWindow(QWidget *parent = nullptr);
    void update(const QJsonObject &status);

private:
    QTreeWidget *m_tree;
    QLabel *m_footer;
    QJsonObject m_last;
    SensorGraphicDelegate *m_gfx;
};
