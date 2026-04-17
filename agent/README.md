# inhouse-agent

Daemon local para `inhouse learn`.

Expone:

- `GET /v1/ping`
- `POST /v1/connect`
- `POST /v1/chat`

Y usa los CLIs locales:

- `codex`
- `gemini`
- `claude`

Para generar los paquetes descargables:

```bash
cd agent
npm run build:releases
```

El release actual publica solo `Windows` y empaqueta:

- `server.js`
- `start-agent.cmd`
- `stop-agent.cmd`

`start-agent.cmd` usa tu instalacion local de `node` para arrancar el daemon en `http://localhost:7823`.
