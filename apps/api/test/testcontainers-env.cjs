const os = require('node:os');
const fs = require('node:fs');

if (!process.env.DOCKER_HOST) {
  const podmanSocket = `/run/user/${os.userInfo().uid}/podman/podman.sock`;
  if (fs.existsSync(podmanSocket)) {
    process.env.DOCKER_HOST = `unix://${podmanSocket}`;
    process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
  }
}
