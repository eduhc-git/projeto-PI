BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE account_status AS ENUM ('pending', 'active', 'suspended', 'deleted');
CREATE TYPE project_visibility AS ENUM ('private', 'unlisted', 'public');
CREATE TYPE listing_status AS ENUM ('draft', 'active', 'paused', 'sold', 'removed');

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    status account_status NOT NULL DEFAULT 'pending',
    email_verified_at TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT users_email_format CHECK (length(email) <= 254 AND position('@' IN email) > 1),
    CONSTRAINT users_password_hash_length CHECK (length(password_hash) BETWEEN 20 AND 255)
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX users_status_idx ON users (status) WHERE deleted_at IS NULL;

CREATE TABLE user_profiles (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    phone TEXT,
    avatar_url TEXT,
    city TEXT,
    state_code CHAR(2),
    country_code CHAR(2) NOT NULL DEFAULT 'BR',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT profiles_display_name_length CHECK (length(display_name) BETWEEN 1 AND 80),
    CONSTRAINT profiles_phone_length CHECK (phone IS NULL OR length(phone) <= 32)
);

CREATE TABLE vehicles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    make TEXT NOT NULL,
    model TEXT NOT NULL,
    trim TEXT,
    model_year SMALLINT,
    production_year SMALLINT,
    nickname TEXT,
    color TEXT,
    engine_code TEXT,
    transmission TEXT,
    fuel_type TEXT,
    plate_last4 CHAR(4),
    vin_last6 CHAR(6),
    odometer_km INTEGER,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT vehicles_year_range CHECK (model_year IS NULL OR model_year BETWEEN 1886 AND 2200),
    CONSTRAINT vehicles_production_year_range CHECK (production_year IS NULL OR production_year BETWEEN 1886 AND 2200),
    CONSTRAINT vehicles_odometer_nonnegative CHECK (odometer_km IS NULL OR odometer_km >= 0),
    CONSTRAINT vehicles_make_model_length CHECK (length(make) BETWEEN 1 AND 80 AND length(model) BETWEEN 1 AND 100)
);
CREATE INDEX vehicles_owner_idx ON vehicles(owner_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vehicle_id UUID REFERENCES vehicles(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    description TEXT,
    visibility project_visibility NOT NULL DEFAULT 'private',
    configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
    estimated_cost_cents BIGINT,
    estimated_power_hp NUMERIC(8,2),
    estimated_torque_nm NUMERIC(8,2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT projects_name_length CHECK (length(name) BETWEEN 1 AND 120),
    CONSTRAINT projects_cost_nonnegative CHECK (estimated_cost_cents IS NULL OR estimated_cost_cents >= 0),
    CONSTRAINT projects_power_nonnegative CHECK (estimated_power_hp IS NULL OR estimated_power_hp >= 0),
    CONSTRAINT projects_torque_nonnegative CHECK (estimated_torque_nm IS NULL OR estimated_torque_nm >= 0),
    CONSTRAINT projects_configuration_object CHECK (jsonb_typeof(configuration) = 'object')
);
CREATE INDEX projects_owner_idx ON projects(owner_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX projects_vehicle_idx ON projects(vehicle_id) WHERE vehicle_id IS NOT NULL;
CREATE INDEX projects_public_idx ON projects(created_at DESC) WHERE visibility = 'public' AND deleted_at IS NULL;

CREATE TABLE project_modifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    cost_cents BIGINT NOT NULL DEFAULT 0,
    power_gain_hp NUMERIC(8,2) NOT NULL DEFAULT 0,
    torque_gain_nm NUMERIC(8,2) NOT NULL DEFAULT 0,
    installed BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT project_mods_nonnegative CHECK (cost_cents >= 0 AND power_gain_hp >= 0 AND torque_gain_nm >= 0),
    CONSTRAINT project_mods_name_length CHECK (length(name) BETWEEN 1 AND 160)
);
CREATE INDEX project_modifications_project_idx ON project_modifications(project_id, created_at);

CREATE TABLE saved_3d_models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    provider TEXT NOT NULL DEFAULT 'sketchfab',
    provider_model_id TEXT NOT NULL,
    title TEXT NOT NULL,
    author_name TEXT,
    license_name TEXT,
    source_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT saved_models_provider_id_unique UNIQUE(owner_id, provider, provider_model_id)
);
CREATE INDEX saved_models_owner_idx ON saved_3d_models(owner_id, created_at DESC);

CREATE TABLE parts_listings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    brand TEXT,
    part_number TEXT,
    condition TEXT NOT NULL DEFAULT 'used',
    price_cents BIGINT NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'BRL',
    compatible_vehicles JSONB NOT NULL DEFAULT '[]'::jsonb,
    status listing_status NOT NULL DEFAULT 'draft',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT listings_price_nonnegative CHECK (price_cents >= 0),
    CONSTRAINT listings_title_length CHECK (length(title) BETWEEN 1 AND 160),
    CONSTRAINT listings_compatibility_array CHECK (jsonb_typeof(compatible_vehicles) = 'array')
);
CREATE INDEX listings_status_created_idx ON parts_listings(status, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX listings_seller_idx ON parts_listings(seller_id, created_at DESC);

CREATE TABLE listing_images (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id UUID NOT NULL REFERENCES parts_listings(id) ON DELETE CASCADE,
    storage_key TEXT NOT NULL,
    alt_text TEXT,
    position SMALLINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT listing_image_position_nonnegative CHECK (position >= 0),
    CONSTRAINT listing_image_storage_key_length CHECK (length(storage_key) BETWEEN 1 AND 512)
);
CREATE INDEX listing_images_listing_idx ON listing_images(listing_id, position);

CREATE TABLE audit_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    entity_type TEXT,
    entity_id UUID,
    ip_address INET,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT audit_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX audit_events_actor_idx ON audit_events(actor_user_id, created_at DESC);
CREATE INDEX audit_events_created_idx ON audit_events(created_at DESC);

COMMIT;
