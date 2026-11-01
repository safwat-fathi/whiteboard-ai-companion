// Step 6 `worker` variant: the scene canvas is an OffscreenCanvas painted here with the `cached` text strategy.
import { makeScene } from './scene';
import { mount, view, measureFrames, checkExtremes, show, open, settle, type Camera } from './render';

let home: Camera;
onmessage = async ({ data }) => {
  if (data.canvas) {
    mount(data.canvas);
    home = { x: 500, y: 300, zoom: 1, dpr: data.dpr };
    Object.assign(view, { els: makeScene(5000, 1, { x: 0, y: 0, w: 1000, h: 600 }), cam: { ...home }, variant: 'cached' });
    postMessage(await measureFrames(home));
  } else if (data.extremes) postMessage(checkExtremes(home, data.cssW, data.cssH));
  else if (data.show) postMessage(await show(home));
  else if (data.settle) postMessage(await settle(data.settle));
  else if (data.json) postMessage(await open(data.json, data.cam));
};
