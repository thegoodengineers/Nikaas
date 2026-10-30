# Deploy (AWS SAM, region ap-south-1)

## Live URLs

| What | URL |
|---|---|
| Website | http://nikaas-webbucket-hbkfctr0cw8s.s3-website.ap-south-1.amazonaws.com |
| API | https://4kzez16ucj.execute-api.ap-south-1.amazonaws.com (try `/health`) |

The API is `nikaas/api.py` as-is: same routes as local, CORS open, gzip on.

| Route | What |
|---|---|
| `GET /health` | `{"ok": true, "routes": [...]}` |
| `POST /validate` | see `docs/CONTRACT.md` |
| `POST /simulate` | see `docs/CONTRACT.md` |
| `POST /optimise` | best exit plan + lower bound (`nikaas/optimise.py`). ~2 s museum, ~8 s lab block. |
| `POST /beat` | time a hand-made `plan` against the optimiser ("Beat Nikaas"). ~3 s. |
| `POST /qa` | graph quality score and warnings (`nikaas/graph_qa.py`). <1 s. |
| `POST /vision` | photo of a floor plan → building graph (+ `quality`). ~20 s. |
| `POST /drill` | Live Drill, presenter: start a drill / block exits; the optimiser re-plans every room. ~3 s. |
| `GET /drill?room=` | Live Drill, phones: that room's exit, distance, walk time, and `alert` when it changed. |

Last checked live on 30 Oct 14:40 IST: all routes 200, museum `/simulate` 145.25 s, `/optimise` 124.0 s; Live Drill:
avhall → West steps 11.7 m, then with WEST blocked → alert, Main entrance 74.2 m.

### `POST /vision`

Body: `{"image": "<base64 PNG/JPEG/WebP, a data: URL is fine>", "width_m": 80, "name": "optional"}`.
`width_m` is the building's real east-west length (photos have no scale). Max photo 3.75 MB.

Returns `{"ok", "id", "building", "problems", "photo_key"}`. `building` is in the contract format and can go
straight to `/simulate` when `ok` is true. `building.vision` says what was guessed:
`exits_added` (from the exits-only pass) and `auto_links` (links the model left out, added to the nearest
walkway). **Exits are the weak part (see `runs/vision_check.md`): let the user confirm them before simulating.**
Stair landings come back as walkway points with `"stair": true` (also listed in `building.vision.stairs`), so
`POST /plans/link-floors` can join floors; `building.vision.photo_m` says where the photo sits in metres, for the
editor's underlay (`#/buildings`).

Errors: 400 not base64, 413 too big, 415 not an image, 422 bad `width_m`, 502 Bedrock failed.
Photos and results are kept 30 days in the private photo bucket (`photos/<id>.<ext>`, `results/<id>.json`).

```js
const image = await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(file) })
const res = await fetch(`${API}/vision`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ image, width_m: 80 }) }).then(r => r.json())
```

## Redeploy the API

Needs Python 3.11 on `PATH` (SAM builds Linux packages for the `python3.11` runtime).

```bash
python scripts/build_lambda.py
sam build
sam deploy
```

`scripts/build_lambda.py` stages only `nikaas/` and the runtime requirements in `build/lambda/` (the template's
`CodeUri`). Packaging the repo root pulls in `web/node_modules` and `data/` and goes over Lambda's 250 MB limit.

numpy/scipy (used by `/optimise`) are capped in `requirements.txt` (numpy < 2.3, scipy < 1.16): newer versions
only ship Linux wheels for glibc 2.28+, and the python3.11 Lambda image has glibc 2.26. Do not lift the cap
without moving the runtime to python3.12+. Never deploy a package without scipy: `nikaas/api.py` imports the
optimiser at start-up, so every route would fail.

Settings (stack `nikaas`, region) are in `samconfig.toml`, so no prompts.

## Platform (sites, check-in, alerts, control room)
The stack also has a DynamoDB table (`LiveTable`, live state with a 24 h TTL on check-ins) and Rekognition access for
confirming camera fire/smoke. Phones only allow push alerts, GPS and the camera on https pages, so share the bucket's
https address, `WebHttpsUrl` in the outputs: https://nikaas-webbucket-hbkfctr0cw8s.s3.ap-south-1.amazonaws.com/index.html
(the S3 website address is http only; CloudFront needs this AWS account verified by AWS Support first). The control-room key is an SSM parameter, made once and never touched by a
redeploy:
```bash
aws ssm put-parameter --name /nikaas/control-key --type SecureString --value "<a long random string>" --region ap-south-1
```
Control endpoints (`POST /sites/{id}/alarm`, hazards, sensors, cameras, `GET /sites/{id}/control`, saving sites) need it in
the `x-control-key` header; the control room asks for it once. Phones never need it. Local runs without the variable are
open. The Web Push key pair (VAPID) is made on first use and stored in the table.

## Emergency texts (SMS)

Amazon SNS only texts once AWS has enabled SMS for the account (new accounts get `AuthorizationError ... spend
threshold` until an AWS Support case raises it). Until then an Android phone can send the texts from its own SIM:

1. Install **SMS Gateway for Android** (open source, `capcom6/android-sms-gateway`) on a phone with a SIM.
2. In the app turn on **Cloud Server**, tap **Start Service**, keep the default **Sign Up**. It shows a username and password.
3. Store them for the API (no redeploy needed, picked up within a minute):
   `aws ssm put-parameter --name /nikaas/sms-gate --type SecureString --value "USERNAME:PASSWORD" --region ap-south-1 --overwrite`

Keep the phone on, with mobile data or Wi-Fi. To go back to SNS, delete the parameter.

## Deploy in one command

Nothing deploys automatically when `main` changes: the live site only updates when someone runs the deploy.
After merging, from an up-to-date `main`:

```powershell
git checkout main; git pull
powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1            # API + website
powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1 -WebOnly   # frontend changes only
```

It warns when the checkout is behind `origin/main` or has uncommitted changes, and prints the live link. Old
website files are kept, so tabs left open across a deploy still work (the app reloads itself onto the new build).
The manual steps below are what the script runs.

## Publish the website

```bash
cd web && npm ci && npm run build && cd ..
aws s3 sync web/dist s3://nikaas-webbucket-hbkfctr0cw8s --exclude index.html --cache-control "public,max-age=300"
aws s3 cp web/dist/index.html s3://nikaas-webbucket-hbkfctr0cw8s/index.html --cache-control no-cache --content-type text/html
aws s3 cp web/dist/sw.js s3://nikaas-webbucket-hbkfctr0cw8s/sw.js --cache-control no-cache --content-type text/javascript
aws s3 cp web/dist/manifest.webmanifest s3://nikaas-webbucket-hbkfctr0cw8s/manifest.webmanifest --cache-control no-cache --content-type application/manifest+json
```

The API URL comes from `web/.env.production` at build time.

## Notes

- Bedrock is called in `us-east-1` (env var `BEDROCK_REGION`, model `BEDROCK_MODEL`, default Nova Pro) until
  ap-south-1 Bedrock access is verified.
- First request after idle takes ~3 s (Lambda cold start); later ones are fast.
- The API is rate-limited to 10 requests/s (bursts of 20) in `template.yaml`, so a public URL cannot burn the
  AWS credits through `/vision` (Bedrock). `GET /drill` (phones polling) has its own 30 req/s (bursts of 60).
  Raise them there if a demo needs more.
- Live Drill state is one object, `drill/state.json`, in the private photo bucket (env `NIKAAS_DRILL_BUCKET`), so
  every Lambda instance sees the same drill. To end a drill so phones show "no drill running":
  `aws s3 rm s3://nikaas-photobucket-dq7kzxtwwyzx/drill/state.json --region ap-south-1`
- Fonts must be served as `font/woff2`: after publishing the website, run
  `aws s3 cp web/dist/fonts s3://nikaas-webbucket-hbkfctr0cw8s/fonts --recursive --content-type font/woff2`
- API Gateway stops waiting after 30 s; `/vision` runs its two Bedrock calls in parallel to stay well under that.
