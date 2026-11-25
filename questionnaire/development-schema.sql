-- SYNTHETIC DEVELOPMENT FIXTURE ONLY. Not a finalized production migration.
-- D05 catalog/security acceptance required before physical production DDL.
DO $$ BEGIN IF current_setting('aegis.questionnaire_development',true) IS DISTINCT FROM 'synthetic-only' THEN RAISE EXCEPTION 'SYNTHETIC_ENVIRONMENT_REQUIRED'; END IF; END $$;
ALTER TABLE sites ADD COLUMN incident_questionnaire_route jsonb;
ALTER TABLE incidents ADD COLUMN questionnaire_binding jsonb, ADD COLUMN guard_session_id integer, ADD COLUMN questionnaire_bound_at timestamptz;
CREATE TABLE incident_questionnaire_scopes (
 id uuid PRIMARY KEY, company_id integer UNIQUE REFERENCES companies(id), kind text NOT NULL CHECK(kind IN ('PLATFORM','TENANT')),
 CHECK ((kind='PLATFORM')=(company_id IS NULL)), UNIQUE(id,company_id)
);
CREATE UNIQUE INDEX iq_one_platform ON incident_questionnaire_scopes(kind) WHERE kind='PLATFORM';
CREATE TABLE incident_questionnaire_definitions (
 id uuid PRIMARY KEY, scope_id uuid NOT NULL REFERENCES incident_questionnaire_scopes(id), site_id integer UNIQUE REFERENCES sites(id),
 draft_revision integer NOT NULL DEFAULT 0 CHECK(draft_revision>=0), draft_envelope jsonb, active_default_version_id uuid,
 UNIQUE(id,scope_id)
);
CREATE UNIQUE INDEX iq_one_default ON incident_questionnaire_definitions(scope_id) WHERE site_id IS NULL;
CREATE TABLE incident_questionnaire_versions (
 id uuid PRIMARY KEY, scope_id uuid NOT NULL, definition_id uuid NOT NULL, version_number integer NOT NULL CHECK(version_number>0),
 title_envelope jsonb NOT NULL, digest text NOT NULL, key_id text NOT NULL, published_by integer NOT NULL, published_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,scope_id), UNIQUE(definition_id,version_number), FOREIGN KEY(definition_id,scope_id) REFERENCES incident_questionnaire_definitions(id,scope_id)
);
ALTER TABLE incident_questionnaire_definitions ADD CONSTRAINT iq_default_head FOREIGN KEY(active_default_version_id) REFERENCES incident_questionnaire_versions(id);
CREATE TABLE incident_questionnaire_question_ids (
 id uuid PRIMARY KEY, definition_id uuid NOT NULL, scope_id uuid NOT NULL, origin_id uuid, legacy_alias text,
 UNIQUE(id,scope_id),FOREIGN KEY(definition_id,scope_id) REFERENCES incident_questionnaire_definitions(id,scope_id)
);
CREATE TABLE incident_questionnaire_version_questions (
 version_id uuid NOT NULL, scope_id uuid NOT NULL, question_id uuid NOT NULL, position integer NOT NULL CHECK(position BETWEEN 1 AND 12),
 type text NOT NULL CHECK(type IN ('SHORT_TEXT','LONG_TEXT')), required boolean NOT NULL,
 max_length integer NOT NULL CHECK(max_length>=1 AND max_length<=CASE WHEN type='SHORT_TEXT' THEN 500 ELSE 5000 END),
 content_envelope jsonb NOT NULL, provenance text NOT NULL CHECK(provenance IN ('PLATFORM_DEFAULT','COMPANY_CUSTOM')),
 PRIMARY KEY(version_id,question_id), UNIQUE(version_id,position),FOREIGN KEY(version_id,scope_id) REFERENCES incident_questionnaire_versions(id,scope_id),
 FOREIGN KEY(question_id,scope_id) REFERENCES incident_questionnaire_question_ids(id,scope_id)
);
CREATE TABLE site_incident_questionnaire_assignments (
 id uuid PRIMARY KEY, scope_id uuid NOT NULL REFERENCES incident_questionnaire_scopes(id), company_id integer NOT NULL, site_id integer NOT NULL REFERENCES sites(id),
 sequence integer NOT NULL CHECK(sequence>0), mode text NOT NULL CHECK(mode IN ('DEFAULT','CUSTOM')), source_scope_id uuid NOT NULL,
 version_id uuid NOT NULL, digest text NOT NULL, actor_id integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(site_id,sequence),UNIQUE(id,scope_id), FOREIGN KEY(scope_id,company_id) REFERENCES incident_questionnaire_scopes(id,company_id),
 FOREIGN KEY(version_id,source_scope_id) REFERENCES incident_questionnaire_versions(id,scope_id)
);
CREATE FUNCTION iq_assignment_integrity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM sites s JOIN incident_questionnaire_versions v ON v.id=NEW.version_id JOIN incident_questionnaire_definitions d ON d.id=v.definition_id JOIN incident_questionnaire_scopes sc ON sc.id=d.scope_id
 WHERE s.id=NEW.site_id AND s.company_id=NEW.company_id AND v.digest=NEW.digest AND ((NEW.mode='DEFAULT' AND sc.kind='PLATFORM' AND d.site_id IS NULL) OR (NEW.mode='CUSTOM' AND sc.company_id=NEW.company_id AND d.site_id=s.id))) THEN RAISE EXCEPTION 'INVALID_ASSIGNMENT'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER iq_assignment_integrity BEFORE INSERT ON site_incident_questionnaire_assignments FOR EACH ROW EXECUTE FUNCTION iq_assignment_integrity();
CREATE TABLE incident_questionnaire_snapshots (
 id uuid PRIMARY KEY, incident_id bigint NOT NULL UNIQUE REFERENCES incidents(id), scope_id uuid NOT NULL REFERENCES incident_questionnaire_scopes(id),
 company_id integer NOT NULL, site_id integer NOT NULL REFERENCES sites(id), guard_id integer NOT NULL REFERENCES guards(id), session_id integer NOT NULL REFERENCES guard_sessions(id),
 assignment_id uuid NOT NULL, source_scope_id uuid NOT NULL, version_id uuid NOT NULL, digest text NOT NULL,title_envelope jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,scope_id), FOREIGN KEY(scope_id,company_id) REFERENCES incident_questionnaire_scopes(id,company_id),
 FOREIGN KEY(assignment_id,scope_id) REFERENCES site_incident_questionnaire_assignments(id,scope_id), FOREIGN KEY(version_id,source_scope_id) REFERENCES incident_questionnaire_versions(id,scope_id)
);
CREATE TABLE incident_questionnaire_snapshot_questions (
 snapshot_id uuid NOT NULL,scope_id uuid NOT NULL,question_id uuid NOT NULL,position integer NOT NULL CHECK(position BETWEEN 1 AND 12),
 type text NOT NULL CHECK(type IN ('SHORT_TEXT','LONG_TEXT')),required boolean NOT NULL,max_length integer NOT NULL,provenance text NOT NULL,
 content_envelope jsonb NOT NULL,PRIMARY KEY(snapshot_id,question_id),UNIQUE(snapshot_id,position),UNIQUE(snapshot_id,question_id,scope_id),
 FOREIGN KEY(snapshot_id,scope_id) REFERENCES incident_questionnaire_snapshots(id,scope_id)
);
CREATE TABLE incident_questionnaire_submissions (
 id uuid PRIMARY KEY,snapshot_id uuid NOT NULL UNIQUE,scope_id uuid NOT NULL,client_submission_id uuid NOT NULL,
 integrity text NOT NULL,integrity_key_id text NOT NULL,receipt_envelope jsonb NOT NULL,answered_count integer NOT NULL CHECK(answered_count BETWEEN 0 AND 12),
 submitted_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,snapshot_id,scope_id),FOREIGN KEY(snapshot_id,scope_id) REFERENCES incident_questionnaire_snapshots(id,scope_id)
);
CREATE TABLE incident_questionnaire_responses (
 submission_id uuid NOT NULL,snapshot_id uuid NOT NULL,scope_id uuid NOT NULL,question_id uuid NOT NULL,answer_envelope jsonb NOT NULL,
 PRIMARY KEY(submission_id,question_id),FOREIGN KEY(submission_id,snapshot_id,scope_id) REFERENCES incident_questionnaire_submissions(id,snapshot_id,scope_id),
 FOREIGN KEY(snapshot_id,question_id,scope_id) REFERENCES incident_questionnaire_snapshot_questions(snapshot_id,question_id,scope_id)
);
CREATE TABLE incident_questionnaire_drafts (
 id uuid PRIMARY KEY,scope_id uuid NOT NULL,snapshot_id uuid NOT NULL,guard_id integer NOT NULL,session_id integer NOT NULL,
 revision integer NOT NULL CHECK(revision>0),state text NOT NULL CHECK(state IN ('CHECKPOINTED','SUBMITTED','REVIEW_REQUIRED','RETENTION_ONLY')),
 checkpoint_envelope jsonb,receipt_envelope jsonb NOT NULL,legal_hold boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now(),review_flag boolean NOT NULL DEFAULT false,
 UNIQUE(snapshot_id,guard_id,session_id),FOREIGN KEY(snapshot_id,scope_id) REFERENCES incident_questionnaire_snapshots(id,scope_id)
);
CREATE TABLE incident_questionnaire_audit_events (
 id uuid PRIMARY KEY,scope_id uuid NOT NULL REFERENCES incident_questionnaire_scopes(id),site_id integer,actor_id integer NOT NULL,
 action text NOT NULL,reference_id uuid,outcome text NOT NULL CHECK(outcome IN ('SUCCESS','DENIED','CONFLICT')),reason text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX iq_audit_page ON incident_questionnaire_audit_events(scope_id,site_id,created_at,id);
CREATE INDEX iq_draft_review ON incident_questionnaire_drafts(scope_id,state,updated_at);
CREATE FUNCTION iq_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QUESTIONNAIRE_IMMUTABLE'; END $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['incident_questionnaire_versions','incident_questionnaire_version_questions','incident_questionnaire_question_ids','site_incident_questionnaire_assignments','incident_questionnaire_snapshots','incident_questionnaire_snapshot_questions','incident_questionnaire_submissions','incident_questionnaire_responses','incident_questionnaire_audit_events'] LOOP EXECUTE format('CREATE TRIGGER iq_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION iq_immutable()',t); END LOOP; END $$;
CREATE FUNCTION iq_definition_integrity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM incident_questionnaire_scopes sc LEFT JOIN sites s ON s.id=NEW.site_id WHERE sc.id=NEW.scope_id AND ((sc.kind='PLATFORM' AND NEW.site_id IS NULL) OR (sc.kind='TENANT' AND s.company_id=sc.company_id))) THEN RAISE EXCEPTION 'INVALID_DEFINITION_OWNER'; END IF;
 IF NEW.active_default_version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM incident_questionnaire_versions v JOIN incident_questionnaire_scopes sc ON sc.id=NEW.scope_id WHERE v.id=NEW.active_default_version_id AND v.definition_id=NEW.id AND v.scope_id=NEW.scope_id AND sc.kind='PLATFORM') THEN RAISE EXCEPTION 'INVALID_DEFAULT_HEAD'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER iq_definition_integrity BEFORE INSERT OR UPDATE ON incident_questionnaire_definitions FOR EACH ROW EXECUTE FUNCTION iq_definition_integrity();
CREATE FUNCTION iq_question_lineage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM incident_questionnaire_question_ids q JOIN incident_questionnaire_versions v ON v.definition_id=q.definition_id AND v.scope_id=q.scope_id WHERE q.id=NEW.question_id AND v.id=NEW.version_id) THEN RAISE EXCEPTION 'INVALID_QUESTION_LINEAGE'; END IF; RETURN NEW; END $$;
CREATE TRIGGER iq_question_lineage BEFORE INSERT ON incident_questionnaire_version_questions FOR EACH ROW EXECUTE FUNCTION iq_question_lineage();
CREATE FUNCTION iq_snapshot_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM incidents i JOIN sites s ON s.id=i.site_id JOIN guard_sessions gs ON gs.id=i.guard_session_id JOIN site_incident_questionnaire_assignments a ON a.id=NEW.assignment_id
 WHERE i.id=NEW.incident_id AND i.company_id=NEW.company_id AND s.company_id=NEW.company_id AND i.site_id=NEW.site_id AND i.guard_ref=NEW.guard_id AND gs.guard_id=NEW.guard_id AND gs.site_id=NEW.site_id AND gs.id=NEW.session_id
 AND a.scope_id=NEW.scope_id AND a.company_id=NEW.company_id AND a.site_id=NEW.site_id AND a.version_id=NEW.version_id AND a.source_scope_id=NEW.source_scope_id AND a.digest=NEW.digest
 AND i.questionnaire_binding->>'assignmentId'=a.id::text AND i.questionnaire_binding->>'versionId'=a.version_id::text AND i.questionnaire_binding->>'digest'=a.digest) THEN RAISE EXCEPTION 'INVALID_SNAPSHOT_IDENTITY'; END IF; RETURN NEW; END $$;
CREATE TRIGGER iq_snapshot_identity BEFORE INSERT ON incident_questionnaire_snapshots FOR EACH ROW EXECUTE FUNCTION iq_snapshot_identity();
CREATE FUNCTION iq_draft_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM incident_questionnaire_snapshots s WHERE s.id=NEW.snapshot_id AND s.scope_id=NEW.scope_id AND s.guard_id=NEW.guard_id AND s.session_id=NEW.session_id) THEN RAISE EXCEPTION 'INVALID_DRAFT_IDENTITY'; END IF;
 IF TG_OP='UPDATE' AND (NEW.id,NEW.scope_id,NEW.snapshot_id,NEW.guard_id,NEW.session_id) IS DISTINCT FROM (OLD.id,OLD.scope_id,OLD.snapshot_id,OLD.guard_id,OLD.session_id) THEN RAISE EXCEPTION 'IMMUTABLE_DRAFT_IDENTITY'; END IF; RETURN NEW; END $$;
CREATE TRIGGER iq_draft_identity BEFORE INSERT OR UPDATE ON incident_questionnaire_drafts FOR EACH ROW EXECUTE FUNCTION iq_draft_identity();
CREATE FUNCTION iq_incident_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.questionnaire_binding,NEW.guard_session_id,NEW.questionnaire_bound_at) IS DISTINCT FROM (OLD.questionnaire_binding,OLD.guard_session_id,OLD.questionnaire_bound_at) THEN RAISE EXCEPTION 'IMMUTABLE_INCIDENT_BINDING'; END IF; RETURN NEW; END $$;
CREATE TRIGGER iq_incident_binding_immutable BEFORE UPDATE ON incidents FOR EACH ROW EXECUTE FUNCTION iq_incident_binding_immutable();
CREATE TABLE incident_questionnaire_legacy_drafts (
 id uuid PRIMARY KEY,scope_id uuid NOT NULL,company_id integer NOT NULL,incident_id bigint NOT NULL REFERENCES incidents(id),
 site_id integer NOT NULL,guard_id integer NOT NULL,session_id integer NOT NULL,revision integer NOT NULL CHECK(revision>0),
 state text NOT NULL CHECK(state IN ('CHECKPOINTED','RETENTION_ONLY','REVIEW_REQUIRED','SUBMITTED')),
 association_status text NOT NULL CHECK(association_status IN ('VERIFIED_SESSION','REVIEW_REQUIRED')),
 checkpoint_envelope jsonb NOT NULL,receipt_envelope jsonb NOT NULL,legal_hold boolean NOT NULL DEFAULT false,updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(incident_id,guard_id,session_id),FOREIGN KEY(scope_id,company_id) REFERENCES incident_questionnaire_scopes(id,company_id)
);
CREATE FUNCTION iq_legacy_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM incidents i JOIN sites s ON s.id=i.site_id JOIN guard_sessions gs ON gs.id=NEW.session_id WHERE i.id=NEW.incident_id AND i.questionnaire_binding IS NULL AND i.company_id=NEW.company_id AND s.company_id=NEW.company_id AND i.site_id=NEW.site_id AND i.guard_ref=NEW.guard_id AND gs.site_id=NEW.site_id AND gs.guard_id=NEW.guard_id) THEN RAISE EXCEPTION 'INVALID_LEGACY_DRAFT_IDENTITY'; END IF;
 IF TG_OP='UPDATE' AND (NEW.id,NEW.scope_id,NEW.company_id,NEW.incident_id,NEW.guard_id,NEW.session_id) IS DISTINCT FROM (OLD.id,OLD.scope_id,OLD.company_id,OLD.incident_id,OLD.guard_id,OLD.session_id) THEN RAISE EXCEPTION 'IMMUTABLE_LEGACY_DRAFT_IDENTITY'; END IF; RETURN NEW; END $$;
CREATE TRIGGER iq_legacy_identity BEFORE INSERT OR UPDATE ON incident_questionnaire_legacy_drafts FOR EACH ROW EXECUTE FUNCTION iq_legacy_identity();
