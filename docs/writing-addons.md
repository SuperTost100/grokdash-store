# Writing an add-on or an app

An **add-on** is one JavaScript file the dashboard runs in its own Node process. An **app** is a set of containers the dashboard's runner starts, for things that need their own service (a WhatsApp bridge, a Python tool). Both talk to the dashboard over its bot API with a token the dashboard hands them.

## Layout

```text
src/<name>/index.mjs        your code; imports ../../sdk/dashboard.mjs and npm packages
addons/<name>/addon.json    the manifest
addons/<name>/index.mjs     built by `npm run build`, committed
apps/<name>/addon.json      an app's manifest
apps/<name>/compose.json    its services (JSON, Compose format)
apps/<name>/adapter/        a service that talks to the dashboard: Dockerfile + built index.mjs
store.json                  what the store offers
```

Run `npm run build` after any change in `src/` or `sdk/`, and commit the built files: the dashboard installs straight from the repo and installs no packages.

## The manifest

```json
{
  "id": "shipments",
  "name": "Shipments",
  "type": "addon",
  "description": "One line for the store page.",
  "color": "#3b6fb6",
  "entry": "index.mjs",
  "asks": ["messages"],
  "settings": [{ "key": "every", "label": "Read every", "type": "number", "default": 10, "help": "Minutes." }]
}
```

- `type`: `addon`, or `app` with `"compose": "compose.json"` and `"memory": "300 MB"` instead of `entry`.
- `asks`: what it needs beyond its own cards and panel: `messages` (read mail and chats), `agenda`, `todos`, `cards`, `handoffs` (give work to Grok bots), `triage` (send messages to triage), `decide` (ask Jev). It only gets them once the owner trusts it.
- `settings`: `text`, `secret` (write-only on the page), `number`, `bool`, `url` or `select` with `options`. `required` and `default` work as you'd expect.

## What runs where

An add-on runs under Node's permission model: it reads only its own folder, writes only `ADDON_DATA`, and can't start programs. Its environment holds only `DASH_URL`, `DASH_TOKEN`, `ADDON_ID`, `ADDON_DATA`, `ADDON_SETTINGS` (JSON), `TZ` and `NODE_ENV`. Network access is open.

An app's `compose.json` must follow the runner's rules:

- Service names start with the app's id (`whatsapp-waha1`, `whatsapp-adapter`). Services reach each other by those names.
- Images, or builds from the app's own folder (`"build": "./adapter"`) or a `https://github.com/…git` repo.
- Named volumes only (`"volumes": ["sessions:/app/.sessions"]` plus a top-level `"volumes": {"sessions": {}}`). No folders from the host, no published ports, no host network, nothing privileged, at most 2 GB of memory each (512 MB if unset).
- Services marked `"x-dashboard": true` get `DASH_URL`, `DASH_TOKEN`, `ADDON_ID`, `ADDON_SETTINGS` and `TZ`. Others never see them.
- `${SETTING_<KEY>}` anywhere in the file is replaced with that setting (key in upper case).

## The SDK

`sdk/dashboard.mjs` covers the whole API. The main calls:

| Call | What it does |
| --- | --- |
| `settings` | The settings, defaults filled in. |
| `every(ms, fn)` | Runs `fn` now and every `ms`. A thrown error becomes the add-on's status on the Add-ons page. |
| `post(card or cards)`, `close(key)` | Cards, as in the dashboard's API reference. Use stable keys. |
| `panel(title, blocks)` | The add-on's panel: `text`, `stats`, `list`, `table`, `buttons`, `image` (data: PNG or JPEG). |
| `status(text, ok)` | One line on the Add-ons page. |
| `agenda(events, from, to)`, `todos(list)` | Replace its events between two days, or its to-dos. |
| `onAction(handler)` | Taps on its cards and panel buttons, and `closed` when the owner closes one of its cards. |
| `readMessages(after)`, `sendMessages(sources, messages)` | Trusted: read the mail and chats the dashboard got, or send new ones to triage. |
| `decide(questions, state)` | Trusted: typed questions for Jev. |
| `handoff(bot, text, urgent)` | Trusted: work for a Grok bot; the answer comes to `onAction`'s `onHandoffResult`. |
| `memory.load(name)`, `memory.save(name, value)` | Small JSON files in the data folder. |

## Testing

Put pure logic (parsing, planning) in functions you export, and test them in `test/<name>.test.mjs` with `node --test`. `npm test` runs them all, and `npm run check` checks every manifest and that the built files are current.
