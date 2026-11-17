-- Five more colour palettes for Settings → Interface: ink, fjord, plum, tide
-- and olive. The four from migration 015 stay, so no saved choice changes.
ALTER TABLE user_settings
  DROP CONSTRAINT user_settings_color_palette_check,
  ADD CONSTRAINT user_settings_color_palette_check
    CHECK ("colorPalette" IN (
      'emerald', 'club', 'midnight', 'walnut',
      'ink', 'fjord', 'plum', 'tide', 'olive'
    ));
