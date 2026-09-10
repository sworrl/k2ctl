#pragma once
#include <QUrl>
#include <QWidget>

class QLabel;
class QNetworkAccessManager;
class QNetworkReply;

// Webcam window. With Qt WebEngine it renders the backend's camera page, which
// negotiates the K2's WebRTC stream; without it, it decodes an MJPEG stream
// (mjpg-streamer style) frame by frame.
class CameraWindow : public QWidget {
    Q_OBJECT
public:
    explicit CameraWindow(QWidget *parent = nullptr);
    void open(const QUrl &backend, const QUrl &mjpeg);

protected:
    void closeEvent(QCloseEvent *ev) override;

private:
    void startMjpeg(const QUrl &url);
    void stopMjpeg();
    QLabel *m_label = nullptr;
    QNetworkAccessManager *m_nam = nullptr;
    QNetworkReply *m_reply = nullptr;
    QByteArray m_buf;
#ifdef K2CTL_WEBENGINE
    class QWebEngineView *m_view = nullptr;
#endif
};
