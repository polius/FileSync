class Turn {
  _username = null;
  _credential = null;
  _expiration = null;

  getServers = async () => {
    await this._getCredentials();
    // Use the hostname as the page is served from. We deliberately do NOT substitute
    // 'localhost' for '127.0.0.1' here: Firefox blocks loopback IP literals in ICE
    // candidate gathering as a privacy measure (prevents fingerprinting local services)
    // but accepts the literal 'localhost' for TCP-based transports. Substituting would
    // strictly worsen Firefox behavior in localhost dev mode while changing nothing in
    // Chrome. In any non-loopback deployment (LAN IP, public IP, domain) both browsers
    // work identically — this code path simply returns whatever the operator's users
    // typed in the address bar.
    const host = window.location.hostname;
    // Provide both UDP and TCP TURN URLs. The browser's ICE agent will prefer UDP
    // when reachable (lower overhead, lower latency) and silently fall back to TCP
    // when UDP is blocked — a common case on corporate networks, some mobile carriers,
    // and most public Wi-Fi captive portals. coturn listens for both on port 3478.
    return [
      { urls: `stun:${host}:3478` },
      {
        urls: [
          `turn:${host}:3478`,
          `turn:${host}:3478?transport=tcp`,
        ],
        username: this._username,
        credential: this._credential,
      },
    ];
  }

  _getCredentials = async () => {
    const now = Math.floor(Date.now() / 1000);

    // Check if token is still valid
    if (this._expiration !== null && this._expiration > now) {
      return { username: this._username, credential: this._credential };
    }

    // Fetch new token
    const response = await fetch("/api/credentials", { method: "GET" });

    if (!response.ok) {
      throw new Error("An issue occurred while getting the token.");
    }

    // Parse the response as JSON
    const data = await response.json();

    const token = data.token
    if (!token) throw new Error("No token in credential response");

    // Decode JWT to get username and credential
    const payload = this._decodeJwt(token);

    // Set cached values
    this._username = payload.username;
    this._credential = payload.credential;
    this._expiration = payload.exp - 10; // Subtract 10 seconds for safety
  };

  _decodeJwt(token) {
    // JWTs are base64url-encoded (with padding stripped); normalize for atob().
    const parts = (token || '').split('.');
    if (parts.length < 2) throw new Error('Malformed JWT.');
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    return JSON.parse(atob(b64));
  }
}

export const turn = new Turn();