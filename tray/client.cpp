#include "client.h"
#include <QJsonArray>

#include <QJsonDocument>
#include <QNetworkReply>
#include <QNetworkRequest>

ApiClient::ApiClient(QObject *parent) : QObject(parent) {
    m_nam.setTransferTimeout(8000);
}

QNetworkReply *ApiClient::get(const QString &path) {
    QUrl u = m_base;
    u.setPath(path);
    return m_nam.get(QNetworkRequest(u));
}

QNetworkReply *ApiClient::post(const QString &path, const QJsonObject &body) {
    QUrl u = m_base;
    u.setPath(path);
    QNetworkRequest req(u);
    req.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    return m_nam.post(req, QJsonDocument(body).toJson(QJsonDocument::Compact));
}

static QJsonObject parse(QNetworkReply *r, QString *err) {
    const QByteArray data = r->readAll();
    const QJsonDocument doc = QJsonDocument::fromJson(data);
    if (r->error() != QNetworkReply::NoError) {
        *err = doc.isObject() && doc.object().contains("error") ? doc.object().value("error").toString() : r->errorString();
        return {};
    }
    if (!doc.isObject()) {
        *err = QStringLiteral("unexpected response");
        return {};
    }
    return doc.object();
}

void ApiClient::fetchStatus() {
    QNetworkReply *r = get("/api/status");
    connect(r, &QNetworkReply::finished, this, [this, r] {
        r->deleteLater();
        QString err;
        const QJsonObject o = parse(r, &err);
        if (!err.isEmpty()) emit requestFailed("status", err);
        else emit statusReceived(o);
    });
}

void ApiClient::fetchProfiles() {
    QNetworkReply *r = get("/api/profiles");
    connect(r, &QNetworkReply::finished, this, [this, r] {
        r->deleteLater();
        const QJsonDocument doc = QJsonDocument::fromJson(r->readAll());
        if (r->error() != QNetworkReply::NoError || !doc.isArray()) {
            emit requestFailed("profiles", r->errorString());
            return;
        }
        emit profilesReceived(doc.array());
    });
}

void ApiClient::setMaterial(int box, int slot, const QString &profileId, const QString &color, bool force) {
    QJsonObject body{{"profile", profileId}};
    if (!color.isEmpty()) body["color"] = color;
    if (force) body["force"] = true;
    QNetworkReply *r = post(QString("/api/cfs/%1/%2/material").arg(box).arg(slot), body);
    connect(r, &QNetworkReply::finished, this, [this, r, box, slot, profileId] {
        r->deleteLater();
        const int code = r->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        const QByteArray raw = r->readAll();
        const QJsonObject o = QJsonDocument::fromJson(raw).object();
        if (code == 409 && o.value("cfs_incompatible").toBool()) {
            emit materialRefused(box, slot, profileId, o.value("reason").toString(o.value("error").toString()));
            return;
        }
        if (r->error() != QNetworkReply::NoError || code >= 400) {
            emit requestFailed("set material", o.contains("error") ? o.value("error").toString() : r->errorString());
            return;
        }
        emit actionDone("set material", o);
    });
}

void ApiClient::setMaterialColors(int box, int slot, const QStringList &colors) {
    QJsonObject body{{"colors", QJsonArray::fromStringList(colors)}};
    QNetworkReply *r = post(QString("/api/cfs/%1/%2/material").arg(box).arg(slot), body);
    connect(r, &QNetworkReply::finished, this, [this, r] {
        r->deleteLater();
        QString err;
        const QJsonObject o = parse(r, &err);
        if (!err.isEmpty()) emit requestFailed("set rainbow", err);
        else emit actionDone("set rainbow", o);
    });
}

void ApiClient::printAction(const QString &action) {
    QJsonObject body;
    if (action == "cancel") body["confirm"] = true;
    QNetworkReply *r = post("/api/print/" + action, body);
    connect(r, &QNetworkReply::finished, this, [this, r, action] {
        r->deleteLater();
        QString err;
        const QJsonObject o = parse(r, &err);
        if (!err.isEmpty()) emit requestFailed(action, err);
        else emit actionDone(action, o);
    });
}

void ApiClient::setLight(bool on) {
    QNetworkReply *r = post("/api/light", QJsonObject{{"on", on}});
    connect(r, &QNetworkReply::finished, this, [this, r] {
        r->deleteLater();
        QString err;
        const QJsonObject o = parse(r, &err);
        if (!err.isEmpty()) emit requestFailed("light", err);
        else emit actionDone("light", o);
    });
}

void ApiClient::setFans(const QJsonObject &body) {
    QNetworkReply *r = post("/api/fans", body);
    connect(r, &QNetworkReply::finished, this, [this, r] {
        r->deleteLater();
        QString err;
        const QJsonObject o = parse(r, &err);
        if (!err.isEmpty()) emit requestFailed("fans", err);
        else emit actionDone("fans", o);
    });
}

void ApiClient::applyRecommendedFans(const QString &profileId) {
    QJsonObject body;
    if (!profileId.isEmpty()) body["profile"] = profileId;
    QNetworkReply *r = post("/api/fans/recommended", body);
    connect(r, &QNetworkReply::finished, this, [this, r] {
        r->deleteLater();
        QString err;
        const QJsonObject o = parse(r, &err);
        if (!err.isEmpty()) emit requestFailed("fans recommended", err);
        else emit actionDone("fans recommended", o);
    });
}
