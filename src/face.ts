// Webcam face tracking via MediaPipe's FaceLandmarker.
// It returns 478 3D landmarks per face plus 52 "blendshapes" (named facial
// expressions scored 0..1, like jawOpen or eyeBlinkLeft). We only need two
// things: where the mouth is, and how open it is.
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

export interface FaceState {
  found: boolean;
  x: number; // mouth centre, normalized 0..1, already mirrored (selfie view)
  y: number;
  jaw: number; // jawOpen blendshape, 0 = closed, ~0.6+ = wide open
  scale: number; // eye-to-eye distance, normalized; proxy for how close you are
}

// Landmark indices into MediaPipe's canonical face mesh.
const UPPER_LIP = 13;
const LOWER_LIP = 14;
const LEFT_EYE_OUTER = 33;
const RIGHT_EYE_OUTER = 263;

export class FaceTracker {
  state: FaceState = { found: false, x: 0.5, y: 0.6, jaw: 0, scale: 0.15 };
  private lastVideoTime = -1;

  private constructor(private landmarker: FaceLandmarker) {}

  static async create(): Promise<FaceTracker> {
    // Model + wasm are served from /public so the game works offline.
    const base = import.meta.env.BASE_URL + "mediapipe";
    const fileset = await FilesetResolver.forVisionTasks(base);
    const landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${base}/face_landmarker.task`, delegate: "GPU" },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
    });
    return new FaceTracker(landmarker);
  }

  update(video: HTMLVideoElement) {
    // Only run the model when the camera has produced a new frame.
    if (video.readyState < 2 || video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = video.currentTime;

    const res = this.landmarker.detectForVideo(video, performance.now());
    const pts = res.faceLandmarks[0];
    if (!pts) {
      this.state.found = false;
      return;
    }
    const s = this.state;
    const mx = 1 - (pts[UPPER_LIP].x + pts[LOWER_LIP].x) / 2;
    const my = (pts[UPPER_LIP].y + pts[LOWER_LIP].y) / 2;
    const jaw =
      res.faceBlendshapes[0]?.categories.find((c) => c.categoryName === "jawOpen")?.score ?? 0;
    const eyeDist = Math.hypot(
      pts[LEFT_EYE_OUTER].x - pts[RIGHT_EYE_OUTER].x,
      pts[LEFT_EYE_OUTER].y - pts[RIGHT_EYE_OUTER].y,
    );

    // Light exponential smoothing: raw landmarks jitter a few pixels per frame.
    // Position gets a high factor (stay responsive), jaw a bit lower.
    const k = s.found ? 0.6 : 1;
    s.x += (mx - s.x) * k;
    s.y += (my - s.y) * k;
    s.jaw += (jaw - s.jaw) * (s.found ? 0.5 : 1);
    s.scale += (eyeDist - s.scale) * 0.2;
    s.found = true;
  }
}
