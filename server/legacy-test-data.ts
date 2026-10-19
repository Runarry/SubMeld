import { record } from './converter/model.js';
import { speedSettingsSchema } from './shared/miaospeed.js';

/** Compatibility is limited to stored settings; new requests use the strict schema. */
export function storedSpeedSettings(input: unknown) {
  if (!record(input)) return speedSettingsSchema.parse(input);
  const value = { ...input };
  delete value.chainCore;
  return speedSettingsSchema.parse(value);
}

export function storedTelegramSettings(input: unknown): unknown {
  if (!record(input) || !record(input.profile)) return input;
  return {
    ...input,
    profile: { ...input.profile, settings: storedSpeedSettings(input.profile.settings) },
  };
}
