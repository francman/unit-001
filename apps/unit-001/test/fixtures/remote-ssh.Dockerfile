FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 2000 unitoperator && useradd -m -u 2000 -g 2000 owner && useradd -m -u 2001 -g users -G unitoperator operator && useradd -m -u 2002 outsider && mkdir /run/sshd
RUN printf '\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAllowStreamLocalForwarding yes\n' >> /etc/ssh/sshd_config
