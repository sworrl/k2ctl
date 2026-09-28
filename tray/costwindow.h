#pragma once
#include <QJsonObject>
#include <QList>
#include <QNetworkAccessManager>
#include <QTemporaryDir>
#include <QUrl>
#include <QWidget>

class QLabel;
class QTextBrowser;
class QPushButton;

// Print cost estimator: pick (or drop) sliced .gcode files or Creality Print .3mf
// projects and the backend prices them with the same prices and power figures as
// the dashboard's print library. A .3mf that was saved without slicing is sliced
// here with the Creality Print command line first, one estimate per plate.
class CostWindow : public QWidget {
    Q_OBJECT
public:
    explicit CostWindow(QWidget *parent = nullptr);
    void setBackend(const QUrl &url) { m_base = url; }
    void browse();
    void addFiles(const QStringList &paths);

protected:
    void dragEnterEvent(class QDragEnterEvent *e) override;
    void dropEvent(class QDropEvent *e) override;

private:
    struct Item {
        QString source;   // the file the user picked
        QString label;    // file name, plus the plate for a .3mf
        QJsonObject est;  // backend answer
        QString error;
    };
    void handle3mf(const QString &path);
    void estimateGcode(const QString &gcodePath, const QString &source, const QString &label);
    void render();
    void setBusy(const QString &msg);

    QUrl m_base;
    QNetworkAccessManager m_nam;
    QList<Item> m_items;
    int m_pending = 0;
    QList<QTemporaryDir *> m_tmp;
    QTemporaryDir m_thumbs;
    QLabel *m_status;
    QTextBrowser *m_view;
    QPushButton *m_clear;
};
