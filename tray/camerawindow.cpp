#include "camerawindow.h"

#include <QCloseEvent>
#include <QLabel>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QPixmap>
#include <QVBoxLayout>
#ifdef K2CTL_WEBENGINE
#include <QWebEngineView>
#include <QWebEngineSettings>
#endif

CameraWindow::CameraWindow(QWidget *parent) : QWidget(parent) {
    setWindowTitle("K2 camera");
    resize(960, 560);
    auto *lay = new QVBoxLayout(this);
    lay->setContentsMargins(0, 0, 0, 0);
#ifdef K2CTL_WEBENGINE
    m_view = new QWebEngineView(this);
    m_view->settings()->setAttribute(QWebEngineSettings::PlaybackRequiresUserGesture, false);
    lay->addWidget(m_view, 1);
#else
    m_label = new QLabel("Connecting to camera…", this);
    m_label->setAlignment(Qt::AlignCenter);
    m_label->setMinimumSize(320, 180);
    m_label->setStyleSheet("background:#000;color:#aaa;");
    lay->addWidget(m_label, 1);
    m_nam = new QNetworkAccessManager(this);
#endif
}

void CameraWindow::open(const QUrl &backend, const QUrl &mjpeg) {
#ifdef K2CTL_WEBENGINE
    Q_UNUSED(mjpeg);
    QUrl u = backend;
    u.setPath("/camera");
    m_view->load(u);
#else
    Q_UNUSED(backend);
    startMjpeg(mjpeg);
#endif
    show();
    raise();
    activateWindow();
}

void CameraWindow::closeEvent(QCloseEvent *ev) {
#ifdef K2CTL_WEBENGINE
    m_view->setUrl(QUrl("about:blank"));
#else
    stopMjpeg();
#endif
    ev->accept();
}

void CameraWindow::startMjpeg(const QUrl &url) {
    stopMjpeg();
    if (!m_nam) return;
    m_buf.clear();
    m_reply = m_nam->get(QNetworkRequest(url));
    connect(m_reply, &QNetworkReply::readyRead, this, [this] {
        m_buf += m_reply->readAll();
        // Pull complete JPEG frames (FFD8 … FFD9) out of the multipart stream.
        for (;;) {
            const int soi = m_buf.indexOf("\xFF\xD8");
            if (soi < 0) { m_buf.clear(); break; }
            const int eoi = m_buf.indexOf("\xFF\xD9", soi + 2);
            if (eoi < 0) { if (soi > 0) m_buf.remove(0, soi); break; }
            QPixmap px;
            if (px.loadFromData(QByteArray::fromRawData(m_buf.constData() + soi, eoi + 2 - soi), "JPEG"))
                m_label->setPixmap(px.scaled(m_label->size(), Qt::KeepAspectRatio, Qt::SmoothTransformation));
            m_buf.remove(0, eoi + 2);
        }
        if (m_buf.size() > 8 * 1024 * 1024) m_buf.clear();
    });
    connect(m_reply, &QNetworkReply::finished, this, [this] {
        if (m_reply && m_reply->error() != QNetworkReply::NoError)
            m_label->setText("Camera stream unavailable: " + m_reply->errorString()
                             + "\n\nThis printer streams over WebRTC; open the dashboard camera page instead.");
    });
}

void CameraWindow::stopMjpeg() {
    if (m_reply) {
        m_reply->abort();
        m_reply->deleteLater();
        m_reply = nullptr;
    }
}
