-- How long the model and Jev took, from this migration on. NULL on older rows reads "not recorded".
ALTER TABLE generations ADD COLUMN ms INTEGER NULL;
ALTER TABLE jev_events ADD COLUMN ms INTEGER NULL;
