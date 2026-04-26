// Thin wrapper around RTCPeerConnection with non-trickle ICE.

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export function createPeer() {
  return new RTCPeerConnection({ iceServers: ICE_SERVERS });
}

export function waitForIceComplete(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const onChange = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", onChange);
    // fallback timeout — some networks never reach "complete"
    setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }, 4000);
  });
}

export async function createOffer(pc) {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceComplete(pc);
  return pc.localDescription;
}

export async function createAnswer(pc, remoteOffer) {
  await pc.setRemoteDescription(remoteOffer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForIceComplete(pc);
  return pc.localDescription;
}

export async function applyAnswer(pc, remoteAnswer) {
  if (pc.signalingState === "stable") return;
  await pc.setRemoteDescription(remoteAnswer);
}

export function watchConnection(pc, onState) {
  const emit = () => onState({
    connection: pc.connectionState,
    ice: pc.iceConnectionState,
    signaling: pc.signalingState,
  });
  pc.addEventListener("connectionstatechange", emit);
  pc.addEventListener("iceconnectionstatechange", emit);
  pc.addEventListener("signalingstatechange", emit);
  emit();
}
