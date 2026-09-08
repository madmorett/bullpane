/**
 * The two numbers that decide when the Overview flags a queue.
 *
 * Stored as one JSON blob in the `settings` table instead of two rows: they are
 * always read and written together, and one key means a partial write cannot
 * leave the pair inconsistent.
 */
import { DEFAULT_ATTENTION_THRESHOLDS, attentionThresholdsSchema, type AttentionThresholds } from "@bullpane/shared";
import type { SettingsStore } from "./settings-store";

const KEY = "attention.thresholds";

export class AttentionService {
  constructor(private readonly settings: SettingsStore) {}

  /**
   * Never throws. A row written by an older (or newer) version that no longer
   * parses falls back to the defaults — the Overview showing stock thresholds
   * beats the whole page failing over a settings row.
   */
  async get(): Promise<AttentionThresholds> {
    const raw = await this.settings.get(KEY);
    if (!raw) return DEFAULT_ATTENTION_THRESHOLDS;
    try {
      return attentionThresholdsSchema.parse(JSON.parse(raw));
    } catch {
      return DEFAULT_ATTENTION_THRESHOLDS;
    }
  }

  async set(input: AttentionThresholds): Promise<AttentionThresholds> {
    const parsed = attentionThresholdsSchema.parse(input);
    await this.settings.set(KEY, JSON.stringify(parsed));
    return parsed;
  }
}
