// Webcam face tracking via MediaPipe's FaceLandmarker.
// It returns 478 3D landmarks per face plus 52 "blendshapes" (named facial
// expressions scored 0..1, like jawOpen or eyeBlinkLeft). For each face we
// pull out: where the mouth is, how open it is, and where the top of the head
// is (for drawing a crown).
//
// This file reports *raw* faces for the current video frame, in no particular
// order. Figuring out which face is which player across frames happens in
// tracks.ts.
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

export interface RawFace {
  x: number; // mouth centre, normalized 0..1, mirrored (selfie view)
  y: number;
  jaw: number; // jawOpen blendshape, 0 = closed, ~0.6+ = wide open
  scale: number; // eye-to-eye distance, normalized; proxy for how close you are
  topX: number; // top of forehead, normalized + mirrored
  topY: number;
  faceH: number; // forehead-to-chin distance, normalized
}

export const MAX_FACES = 4;

// Landmark indices into MediaPipe's canonical face mesh.
const UPPER_LIP = 13;
const LOWER_LIP = 14;
const LEFT_EYE_OUTER = 33;
const RIGHT_EYE_OUTER = 263;
const FOREHEAD = 10;
const CHIN = 152;

export class FaceTracker {
  faces: RawFace[] = [];
  private lastVideoTime = -1;

  private constructor(private landmarker: FaceLandmarker) {}

  static async create(): Promise<FaceTracker> {
    // Model + wasm are served from /public so the game works offline.
    const base = import.meta.env.BASE_URL + "mediapipe";
    const fileset = await FilesetResolver.forVisionTasks(base);
    const landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${base}/face_landmarker.task`, delegate: "GPU" },
      runningMode: "VIDEO",
      numFaces: MAX_FACES,
      outputFaceBlendshapes: true,
    });
    return new FaceTracker(landmarker);
  }

  /** Returns true if a new camera frame was processed. */
  update(video: HTMLVideoElement): boolean {
    // Only run the model when the camera has produced a new frame.
    if (video.readyState < 2 || video.currentTime === this.lastVideoTime) return false;
    this.lastVideoTime = video.currentTime;

    const res = this.landmarker.detectForVideo(video, performance.now());
    this.faces = res.faceLandmarks.map((pts, i) => {
      const jaw =
        res.faceBlendshapes[i]?.categories.find((c) => c.categoryName === "jawOpen")?.score ?? 0;
      return {
        x: 1 - (pts[UPPER_LIP].x + pts[LOWER_LIP].x) / 2,
        y: (pts[UPPER_LIP].y + pts[LOWER_LIP].y) / 2,
        jaw,
        scale: Math.hypot(pts[LEFT_EYE_OUTER].x - pts[RIGHT_EYE_OUTER].x, pts[LEFT_EYE_OUTER].y - pts[RIGHT_EYE_OUTER].y),
        topX: 1 - pts[FOREHEAD].x,
        topY: pts[FOREHEAD].y,
        faceH: Math.hypot(pts[FOREHEAD].x - pts[CHIN].x, pts[FOREHEAD].y - pts[CHIN].y),
      };
    });
    return true;
  }
}
