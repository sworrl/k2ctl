#pragma once
#include <QJsonArray>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QObject>
#include <QUrl>

// Thin client for the k2ctl backend API.
class ApiClient : public QObject {
    Q_OBJECT
public:
    explicit ApiClient(QObject *parent = nullptr);
    void setBaseUrl(const QUrl &url) { m_base = url; }
    QUrl baseUrl() const { return m_base; }

    void fetchStatus();
    void fetchProfiles();
    // force=true records a profile the catalog marks as not CFS-compatible anyway.
    void setMaterial(int box, int slot, const QString &profileId, const QString &color = QString(), bool force = false);
    // Multi-colour (rainbow) spool: the backend keeps the list and gives the printer the middle colour.
    void setMaterialColors(int box, int slot, const QStringList &colors);
    void printAction(const QString &action);
    void setLight(bool on);
    // Fans: body keys part|aux|chamber (percent) and/or part_on|aux_on|chamber_on (bool).
    void setFans(const QJsonObject &body);
    void applyRecommendedFans(const QString &profileId = QString());

signals:
    void statusReceived(const QJsonObject &status);
    void profilesReceived(const QJsonArray &profiles);
    void requestFailed(const QString &what, const QString &error);
    void actionDone(const QString &what, const QJsonObject &result);
    // The backend refused a CFS bay assignment (HTTP 409, cfs_incompatible).
    void materialRefused(int box, int slot, const QString &profileId, const QString &reason);

private:
    QNetworkReply *get(const QString &path);
    QNetworkReply *post(const QString &path, const QJsonObject &body);
    QUrl m_base;
    QNetworkAccessManager m_nam;
};
