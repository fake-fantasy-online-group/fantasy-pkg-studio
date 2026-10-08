'use strict';

const vscode = acquireVsCodeApi();
const root = document.getElementById('animation');
const image = document.getElementById('frame-image');
const direction = document.getElementById('direction');
const frame = document.getElementById('frame');
const frameLabel = document.getElementById('frame-label');
const play = document.getElementById('play');
const fps = document.getElementById('fps');
const status = document.getElementById('status');
const framesPerDirection = Number(root.dataset.framesPerDirection);
const directionCount = direction.options.length;
const totalFrames = framesPerDirection * directionCount;
let currentIndex = Number(root.dataset.frameIndex) || 0;
let sequence = 0;
let activeSequence = 0;
let requestedIndex = -1;
let pendingIndex = null;
let inFlight = false;
let timer = null;
let uiVisible = !document.hidden;

frame.max = String(framesPerDirection - 1);

function localFrame(flatIndex) { return flatIndex % framesPerDirection; }
function flatIndex(directionIndex, localIndex) { return directionIndex * framesPerDirection + localIndex; }
function updateControls(index) {
  const bounded = ((index % totalFrames) + totalFrames) % totalFrames;
  currentIndex = bounded;
  direction.value = String(Math.floor(bounded / framesPerDirection));
  frame.value = String(localFrame(bounded));
  frameLabel.textContent = `${localFrame(bounded) + 1} / ${framesPerDirection}`;
}
function sendPending() {
  if (inFlight || pendingIndex === null || document.hidden || !uiVisible) return;
  const index = pendingIndex;
  pendingIndex = null;
  inFlight = true;
  requestedIndex = index;
  activeSequence = ++sequence;
  status.textContent = '';
  vscode.postMessage({ type: 'frame', sequence: activeSequence, frameIndex: index });
}
function request(index) {
  const bounded = ((index % totalFrames) + totalFrames) % totalFrames;
  updateControls(bounded);
  pendingIndex = bounded;
  sendPending();
}
function stepFrame(delta) {
  const directionIndex = Number(direction.value);
  const local = ((localFrame(currentIndex) + delta) % framesPerDirection + framesPerDirection) % framesPerDirection;
  request(flatIndex(directionIndex, local));
}
function stopPlayback() {
  if (timer !== null) clearInterval(timer);
  timer = null;
  play.textContent = '播放';
  play.setAttribute('aria-pressed', 'false');
}
function startPlayback() {
  stopPlayback();
  play.textContent = '暂停';
  play.setAttribute('aria-pressed', 'true');
  const interval = Math.max(34, 1000 / Math.min(30, Math.max(1, Number(fps.value) || 8)));
  timer = setInterval(() => {
    if (inFlight || pendingIndex !== null || document.hidden) return;
    stepFrame(1);
  }, interval);
}

direction.addEventListener('change', () => request(flatIndex(Number(direction.value), localFrame(currentIndex))));
frame.addEventListener('input', () => request(flatIndex(Number(direction.value), Number(frame.value))));
document.getElementById('previous').addEventListener('click', () => stepFrame(-1));
document.getElementById('next').addEventListener('click', () => stepFrame(1));
play.addEventListener('click', () => timer === null ? startPlayback() : stopPlayback());
fps.addEventListener('change', () => { if (timer !== null) startPlayback(); });
function setVisible(visible) {
  if (uiVisible === visible) { if (visible) sendPending(); return; }
  uiVisible = visible;
  if (!visible) {
    stopPlayback();
    if (inFlight && pendingIndex === null) pendingIndex = requestedIndex;
    inFlight = false;
    requestedIndex = -1;
    activeSequence = ++sequence;
  } else {
    sendPending();
  }
}
document.addEventListener('visibilitychange', () => setVisible(!document.hidden));
window.addEventListener('message', event => {
  const message = event.data;
  if (!message) return;
  if (message.type === 'visibility') {
    setVisible(Boolean(message.visible));
    return;
  }
  if (message.type !== 'frame') return;
  if (!inFlight || message.sequence !== activeSequence || message.frameIndex !== requestedIndex) return;
  inFlight = false;
  requestedIndex = -1;
  if (pendingIndex === null && message.base64) {
    image.src = `data:image/png;base64,${message.base64}`;
    updateControls(message.frameIndex);
  }
  if (message.error) {
    stopPlayback();
    status.textContent = String(message.error);
  }
  sendPending();
});
window.addEventListener('unload', () => { stopPlayback(); pendingIndex = null; }, { once: true });
