#include <QIcon>
#include <QApplication>
#include <QSystemTrayIcon>
#include <QMessageBox>

#include "tray.h"

int main(int argc, char **argv) {
    QApplication app(argc, argv);
    app.setApplicationName("k2ctl-tray");
    app.setOrganizationName("k2ctl");
    app.setWindowIcon(QIcon(":/k2ctl-icon.png"));
    app.setQuitOnLastWindowClosed(false);
    if (!QSystemTrayIcon::isSystemTrayAvailable()) {
        QMessageBox::critical(nullptr, "K2 tray", "No system tray available on this desktop.");
        return 1;
    }
    TrayApp tray;
    return app.exec();
}
