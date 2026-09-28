#pragma once
#include <QJsonArray>
#include <QJsonObject>
#include <QMenu>
#include <QObject>
#include <QSystemTrayIcon>
#include <QTimer>

#include "client.h"

class SensorsWindow;
class CameraWindow;
class CostWindow;

class TrayApp : public QObject {
    Q_OBJECT
public:
    explicit TrayApp(QObject *parent = nullptr);

private:
    void loadSettings();
    void rebuildMenu();
    void applyStatus(const QJsonObject &st);
    void buildFilamentMenu(QMenu *menu);
    void buildFansMenu(QMenu *menu);
    void confirmCancel();
    void openSettings();
    static QPixmap slotSwatch(const QJsonObject &slot);
    void openDashboard();
    void openCamera();
    void openSensors();
    void openCost();
    QIcon stateIcon() const;
    QString stateSummary() const;

    ApiClient m_api;
    QSystemTrayIcon m_tray;
    QMenu m_menu;
    QTimer m_timer;
    QJsonObject m_status;
    QJsonArray m_profiles;
    bool m_online = false;
    QString m_lastError;
    QUrl m_mjpeg;
    SensorsWindow *m_sensors = nullptr;
    CameraWindow *m_camera = nullptr;
    CostWindow *m_cost = nullptr;
};
