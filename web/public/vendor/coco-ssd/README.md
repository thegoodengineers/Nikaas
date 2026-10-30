# Person detector for Nikaas Live (`#/cam`)

Vendored because the npm registry is blocked at the venue, and so the camera page works offline.

- `../tfjs/tf.min.js`: TensorFlow.js 4.22.0 (Apache-2.0), from cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js
- `coco-ssd.min.js`: @tensorflow-models/coco-ssd 2.2.3 (Apache-2.0), from cdn.jsdelivr.net
- `model.json` + `group1-shard*`: SSDLite MobileNet v2 (COCO), from storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/

Runs entirely in the browser: video frames never leave the laptop, only the head count is sent.
