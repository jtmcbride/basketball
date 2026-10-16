import type { ReplayBundle } from "../types";
export interface Annotation {
  annotation_id: string;
  kind: "catch" | "release" | "screen" | "cut" | "relocation" | "uncertain";
  label: string;
  confidence: "uncertain" | "supported" | "validated";
  basis:
    | "tracking_review"
    | "video_review"
    | "source_annotation"
    | "synthetic_fixture";
  start_frame_id: string;
  anchor_frame_id: string;
  end_frame_id: string;
  start_index: number;
  anchor_index: number;
  end_index: number;
  elapsed_s: number;
  uncertainty_start_s: number;
  uncertainty_end_s: number;
  reviewer: string;
  reviewed_at: string;
  notes: string;
  evidence_uri: string | null;
}
export interface Sequence {
  sequence_id: string;
  title: string;
  game_id: string;
  segment_id: string;
  player_id: string;
  start_frame_id: string;
  end_frame_id: string;
  start_index: number;
  end_index: number;
  default_anchor_id: string;
  split: "development" | "held_out";
  annotation_coverage: "partial" | "exhaustive_catches";
  annotations: Annotation[];
  status: "available" | "unavailable";
  reason: string | null;
}
export interface AnnotationSet {
  schema_version: "basketball-annotations-v1";
  collection_id: string;
  revision: number;
  dataset_kind: "historical" | "synthetic";
  source_fingerprint: string;
  pipeline_version: string;
  description: string;
  sequences: Sequence[];
  automatic_labels: { available: false; reason: string };
}
export interface BoundSequence {
  sequence: Sequence;
  annotation: Annotation;
  bundle: ReplayBundle;
}

export function bindClient(
  set: AnnotationSet,
  sequence: Sequence,
  bundle: ReplayBundle,
  annotationId: string,
): BoundSequence {
  if (
    set.source_fingerprint !== bundle.provenance.source_fingerprint ||
    set.pipeline_version !== bundle.provenance.pipeline_version ||
    sequence.game_id !== bundle.game_id ||
    sequence.segment_id !== bundle.segment_id
  )
    throw new Error("Annotations do not match the current tracking source.");
  const validIndex = (index: number, id: string) =>
    Number.isInteger(index) &&
    index >= 0 &&
    index < bundle.frames.length &&
    bundle.frames[index].frame_id === id;
  if (
    !validIndex(sequence.start_index, sequence.start_frame_id) ||
    !validIndex(sequence.end_index, sequence.end_frame_id) ||
    sequence.start_index > sequence.end_index
  )
    throw new Error("Sequence frame references are unavailable.");
  const annotation = sequence.annotations.find(
    (a) => a.annotation_id === annotationId,
  );
  if (
    !annotation ||
    !validIndex(annotation.start_index, annotation.start_frame_id) ||
    !validIndex(annotation.anchor_index, annotation.anchor_frame_id) ||
    !validIndex(annotation.end_index, annotation.end_frame_id) ||
    !(
      sequence.start_index <= annotation.start_index &&
      annotation.start_index <= annotation.anchor_index &&
      annotation.anchor_index <= annotation.end_index &&
      annotation.end_index <= sequence.end_index
    )
  )
    throw new Error("Annotation reference or uncertainty interval is invalid.");
  const frame = bundle.frames[annotation.anchor_index];
  if (
    frame.timestamp_conflict ||
    frame.entities.filter(
      (e) =>
        e.entity_id === sequence.player_id &&
        e.kind === "player" &&
        e.team_id ===
          bundle.players.find((p) => p.player_id === sequence.player_id)
            ?.team_id,
    ).length !== 1
  )
    throw new Error("Annotated player is unavailable at the reference frame.");
  return { sequence, annotation, bundle };
}
