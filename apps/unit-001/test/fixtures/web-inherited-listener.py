"""Supply Linux sockets to a Node process using systemd's descriptor convention."""

import json
import os
import socket
import sys


node, kind, path, overrides = sys.argv[1:]

if kind == "tcp":
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
else:
    socket_type = {
        "datagram": socket.SOCK_DGRAM,
        "seqpacket": socket.SOCK_SEQPACKET,
    }.get(kind, socket.SOCK_STREAM)
    listener = socket.socket(socket.AF_UNIX, socket_type)
    address = {
        "control": path + ".control",
        "abstract": "\0" + path,
        "newline": path + "\nextra",
    }.get(kind, path)
    listener.bind(address)

if kind not in {"bound", "datagram"}:
    listener.listen()

fd = listener.fileno()
if kind == "control":
    os.link(address, path)
elif kind == "connected":
    peer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    peer.connect(path)
    connection, _ = listener.accept()
    fd = connection.fileno()
elif kind == "fd4":
    os.dup2(fd, 4)
    fd = os.open("/dev/null", os.O_RDONLY)

os.dup2(fd, 3)
os.set_inheritable(3, True)
os.environ.update(LISTEN_PID=str(os.getpid()), LISTEN_FDS="1", LISTEN_FDNAMES="unit-001-web")
for key, value in json.loads(overrides).items():
    if value is None:
        os.environ.pop(key, None)
    else:
        os.environ[key] = value

script = """
import { once } from 'node:events';
import { createServer, get } from 'node:http';
import { readInheritedWebListener } from './src/web/inherited-listener.ts';

const [path, kind] = process.argv.slice(1);
const fd = await readInheritedWebListener(path);
if (kind === 'adopt') {
    const server = createServer((_req, res) => res.end('adopted on fd ' + fd));
    await once(server.listen({ fd }), 'listening');
    try {
        const [response] = await once(get({ socketPath: path, agent: false }), 'response');
        for await (const chunk of response) process.stdout.write(chunk);
    } finally {
        server.close();
    }
} else {
    console.log(fd);
}
"""
os.execv(node, [node, "--experimental-strip-types", "--input-type=module", "-e", script, path, kind])
