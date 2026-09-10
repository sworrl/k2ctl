/* bindshim: LD_PRELOAD for Creality's web-server on the K2 (also fits the K2 Plus/Pro).
 * Its listen ports are compiled in (80 / 443 / 9999). This remaps bind() on TCP port
 * K2_REMAP_FROM (default 443) to K2_REMAP_TO (default 8443) so k2ctl can own 443.
 * Loaded system-wide through /etc/ld.so.preload (so Creality's Monitor watchdog, which
 * relaunches /usr/bin/web-server by path, keeps its shim) but it only acts inside the
 * program named K2_REMAP_EXE (default "web-server"); every other process gets a plain bind().
 * Uses the raw syscall instead of dlsym(RTLD_NEXT) so it links against the printer's
 * glibc 2.29 without newer symbol versions.  Build: deploy/install-443.sh. */
#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/syscall.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

extern char *program_invocation_short_name;

static int is_target(void) {
    static int cached = -1;
    if (cached < 0) {
        const char *want = getenv("K2_REMAP_EXE");
        if (!want || !*want) want = "web-server";
        const char *me = program_invocation_short_name ? program_invocation_short_name : "";
        cached = strcmp(me, want) == 0;
    }
    return cached;
}

static int env_port(const char *name, int dflt) {
    const char *v = getenv(name);
    if (!v || !*v) return dflt;
    int n = 0; while (*v >= '0' && *v <= '9') n = n * 10 + (*v++ - '0');
    return n ? n : dflt;
}

int bind(int fd, const struct sockaddr *addr, socklen_t len) {
    struct sockaddr_storage copy;
    const struct sockaddr *use = addr;
    if (is_target() && addr && len <= sizeof copy) {
        int from = env_port("K2_REMAP_FROM", 443), to = env_port("K2_REMAP_TO", 8443);
        if (addr->sa_family == AF_INET && len >= sizeof(struct sockaddr_in)) {
            struct sockaddr_in *in = (struct sockaddr_in *)memcpy(&copy, addr, len);
            if (ntohs(in->sin_port) == from) { in->sin_port = htons(to); use = (struct sockaddr *)in; }
        } else if (addr->sa_family == AF_INET6 && len >= sizeof(struct sockaddr_in6)) {
            struct sockaddr_in6 *in6 = (struct sockaddr_in6 *)memcpy(&copy, addr, len);
            if (ntohs(in6->sin6_port) == from) { in6->sin6_port = htons(to); use = (struct sockaddr *)in6; }
        }
    }
    return (int)syscall(SYS_bind, fd, use, len);
}
