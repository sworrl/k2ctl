#include <QIcon>
#include <QApplication>
#include <QSystemTrayIcon>
#include <QMessageBox>

#include <QSettings>
#include <QTimer>
#include <QUrl>

#include "costwindow.h"
#include "tray.h"

int main(int argc, char **argv) {
    QApplication app(argc, argv);
    app.setApplicationName("k2ctl-tray");
    app.setOrganizationName("k2ctl");
    app.setWindowIcon(QIcon(":/k2ctl-icon.png"));
    // k2ctl-tray --cost [FILE...]: only the print cost window (for "Open with" in a file
    // manager); it prices the files given and quits when closed.
    const QStringList args = app.arguments();
    if (args.size() > 1 && args.at(1) == "--cost") {
        CostWindow w;
        w.setBackend(QUrl(QSettings("k2ctl", "tray").value("backend", "").toString()));
        w.show();
        if (args.size() > 2) w.addFiles(args.mid(2));
        else QTimer::singleShot(0, &w, &CostWindow::browse);
        return app.exec();
    }
    app.setQuitOnLastWindowClosed(false);
    if (!QSystemTrayIcon::isSystemTrayAvailable()) {
        QMessageBox::critical(nullptr, "K2 tray", "No system tray available on this desktop.");
        return 1;
    }
    TrayApp tray;
    return app.exec();
}
