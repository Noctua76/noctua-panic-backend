ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS site_prefix VARCHAR(8),
  ADD COLUMN IF NOT EXISTS next_site_number INTEGER NOT NULL DEFAULT 1;

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS site_number INTEGER,
  ADD COLUMN IF NOT EXISTS site_code VARCHAR(24);

-- Allocate persistent prefixes in a deterministic order; reserve DEF for Defensor.
DO $$
DECLARE
  company_record RECORD;
  base_prefix TEXT;
  candidate TEXT;
  suffix TEXT;
  attempt INTEGER;
BEGIN
  FOR company_record IN
    SELECT id, name FROM companies
    ORDER BY (upper(btrim(name)) = 'DEFENSOR CIVITATIS SECURITY') DESC, id ASC
  LOOP
    IF EXISTS (SELECT 1 FROM companies WHERE id = company_record.id AND site_prefix IS NOT NULL) THEN
      CONTINUE;
    END IF;
    IF upper(btrim(company_record.name)) = 'DEFENSOR CIVITATIS SECURITY' THEN
      base_prefix := 'DEF';
    ELSE
      SELECT string_agg(left(word, 1), '' ORDER BY ord) INTO base_prefix
      FROM (
        SELECT word, ord
        FROM regexp_split_to_table(upper(company_record.name), '[^A-Z0-9]+')
          WITH ORDINALITY AS words(word, ord)
        WHERE word <> ''
        ORDER BY ord LIMIT 3
      ) initials;
      IF length(coalesce(base_prefix, '')) < 2 THEN
        base_prefix := left(regexp_replace(upper(company_record.name), '[^A-Z0-9]', '', 'g'), 3);
      END IF;
      IF length(coalesce(base_prefix, '')) < 2 THEN base_prefix := 'CO'; END IF;
    END IF;

    candidate := base_prefix;
    attempt := 0;
    WHILE EXISTS (SELECT 1 FROM companies WHERE site_prefix = candidate) LOOP
      attempt := attempt + 1;
      suffix := attempt::text;
      IF length(suffix) > 6 THEN RAISE EXCEPTION 'No available operational site prefix'; END IF;
      candidate := left(base_prefix, 8 - length(suffix)) || suffix;
    END LOOP;
    UPDATE companies SET site_prefix = candidate WHERE id = company_record.id;
  END LOOP;
END $$;

-- Existing sites receive numbers in their company's original database ID order.
WITH ranked AS (
  SELECT id, company_id,
         row_number() OVER (PARTITION BY company_id ORDER BY id ASC)::integer AS sequence_number
  FROM sites
)
UPDATE sites s
SET site_number = r.sequence_number,
    site_code = c.site_prefix || '-' ||
      CASE WHEN r.sequence_number < 1000 THEN lpad(r.sequence_number::text, 3, '0')
           ELSE r.sequence_number::text END
FROM ranked r JOIN companies c ON c.id = r.company_id
WHERE s.id = r.id AND s.site_code IS NULL;

UPDATE companies c
SET next_site_number = coalesce(
  (SELECT max(s.site_number) + 1 FROM sites s WHERE s.company_id = c.id), 1
);

ALTER TABLE companies
  ALTER COLUMN site_prefix SET NOT NULL,
  ADD CONSTRAINT companies_site_prefix_format
    CHECK (site_prefix ~ '^[A-Z0-9]{2,8}$'),
  ADD CONSTRAINT companies_next_site_number_positive
    CHECK (next_site_number >= 1);
CREATE UNIQUE INDEX companies_site_prefix_unique ON companies(site_prefix);

ALTER TABLE sites
  ALTER COLUMN site_number SET NOT NULL,
  ALTER COLUMN site_code SET NOT NULL,
  ADD CONSTRAINT sites_site_number_positive CHECK (site_number >= 1),
  ADD CONSTRAINT sites_site_code_format
    CHECK (site_code ~ '^[A-Z0-9]{2,8}-[0-9]{3,}$');
CREATE UNIQUE INDEX sites_company_site_number_unique ON sites(company_id, site_number);
CREATE UNIQUE INDEX sites_site_code_unique ON sites(site_code);

CREATE FUNCTION prevent_operational_site_identity_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.site_number IS DISTINCT FROM NEW.site_number OR
     OLD.site_code IS DISTINCT FROM NEW.site_code OR
     OLD.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'Operational Site ID and its company cannot be changed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER operational_site_identity_immutable
  BEFORE UPDATE OF site_number, site_code, company_id ON sites
  FOR EACH ROW EXECUTE FUNCTION prevent_operational_site_identity_change();

CREATE FUNCTION prevent_allocated_site_prefix_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.site_prefix IS DISTINCT FROM NEW.site_prefix AND OLD.next_site_number > 1 THEN
    RAISE EXCEPTION 'Company operational site prefix is locked after site allocation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER allocated_site_prefix_immutable
  BEFORE UPDATE OF site_prefix ON companies
  FOR EACH ROW EXECUTE FUNCTION prevent_allocated_site_prefix_change();
