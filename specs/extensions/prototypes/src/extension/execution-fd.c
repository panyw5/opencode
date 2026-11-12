#include <errno.h>
#include <fcntl.h>
#include <unistd.h>

int duplicate_control_fd(int fd) {
  return fcntl(fd, F_DUPFD_CLOEXEC, 0);
}

int close_control_fd(int fd) {
  return close(fd);
}

int control_fd_errno(void) {
  return errno;
}
