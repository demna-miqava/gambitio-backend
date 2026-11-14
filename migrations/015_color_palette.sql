-- The colour palette picked in Settings → Interface. The frontend keeps a
-- copy on the device so the right colours show before settings load.
-- A CHECK rather than an enum type, so palettes can be added or removed by
-- replacing the constraint.
ALTER TABLE user_settings
  ADD COLUMN "colorPalette" text NOT NULL DEFAULT 'emerald'
  CONSTRAINT user_settings_color_palette_check
    CHECK ("colorPalette" IN ('emerald', 'club', 'midnight', 'walnut'));
