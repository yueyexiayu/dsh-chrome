/* Resolve the peer of an inherited Unix-socket fd.
 * fd 3 is a dup of the accepted socket. Closing it must not close the parent fd.
 * LOCAL_PEERPID + proc_pidpath cannot be spoofed by argv.
 */
#include <errno.h>
#include <libproc.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

int main(void) {
  int fd = 3;
  pid_t pid = 0;
  socklen_t len = sizeof(pid);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &len) != 0) {
    fprintf(stderr, "peerpath: getsockopt: %s\n", strerror(errno));
    return 1;
  }
  if (pid <= 0) {
    fprintf(stderr, "peerpath: empty peer pid\n");
    return 1;
  }
  char path[PROC_PIDPATHINFO_MAXSIZE];
  int n = proc_pidpath(pid, path, sizeof(path));
  if (n <= 0) {
    fprintf(stderr, "peerpath: proc_pidpath: %s\n", strerror(errno));
    return 2;
  }
  fwrite(path, 1, (size_t)n, stdout);
  fputc('\n', stdout);
  return 0;
}
