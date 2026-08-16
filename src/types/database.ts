/**
 * Release 1 database contract. Keep this file aligned with the append-only
 * migration until Supabase type generation is wired into CI.
 */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type Table<Row, Insert = Partial<Row>, Update = Partial<Insert>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export type WorkspaceRole = "owner" | "admin" | "analyst" | "viewer";
export type ProviderKey = "openai" | "claude" | "google_ai_overview";
export type RunStatus = "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";
export type JobStatus = "queued" | "leased" | "succeeded" | "failed" | "unavailable" | "cancelled";

export type ProjectRow = {
  id: string; workspace_id: string; name: string; domain: string | null;
  category: string | null; default_market: string; default_locale: string;
  languages: string[]; status: "draft" | "active" | "archived";
  created_by: string | null; created_at: string; updated_at: string;
};
export type QuestionRow = {
  id: string; workspace_id: string; project_id: string; current_prompt: string;
  market: string; locale: string; active: boolean; question_type: string; persona: string | null;
  stage: string | null; rationale: string | null; state: "active" | "disqualified" | "archived";
  disqualification_reason: string | null; current_version: number;
  created_by: string | null; created_at: string; updated_at: string;
};
export type QuestionSetRow = {
  id: string; workspace_id: string; project_id: string; name: string;
  version: number; cohort_hash: string; created_by: string | null; created_at: string;
};
export type QuestionSetItemRow = {
  workspace_id: string; project_id: string; question_set_id: string;
  question_version_id: string; position: number;
};
export type SourceRow = {
  id: string; workspace_id: string; project_id: string; kind: "url" | "text" | "file";
  name: string; original_url: string | null; canonical_url: string | null;
  state: "active" | "unavailable" | "archived"; retrieval_allowed: boolean;
  quoting_allowed: boolean; export_allowed: boolean; authority_weight: number;
  freshness_days: number; created_by: string | null; created_at: string; updated_at: string;
};
export type RunRow = {
  id: string; workspace_id: string; project_id: string; project_version_id: string | null;
  question_set_id: string | null; schedule_id: string | null; status: RunStatus; requested_by: string | null;
  idempotency_key: string | null; request_fingerprint: string | null; requested_capture_count: number;
  reserved_call_count: number; reserved_cost_usd: number; estimated_max_cost_usd: number | null; started_at: string | null;
  completed_at: string | null; cancelled_at: string | null;
  cancellation_reason: string | null; created_at: string;
};
export type RunItemRow = {
  id: string; workspace_id: string; project_id: string; run_id: string;
  question_version_id: string; provider: ProviderKey; locale: string; market: string;
  status: JobStatus; idempotency_key: string; attempt_count: number; max_attempts: number;
  lease_owner: string | null; lease_started_at: string | null; lease_expires_at: string | null; last_error_code: string | null;
  available_at: string; started_at: string | null; completed_at: string | null; created_at: string;
};
export type ObservationRow = {
  id: string; workspace_id: string; project_id: string; run_id: string;
  question_id: string; run_item_id: string | null; capture_attempt_id: string | null;
  provider: ProviderKey; status: "succeeded" | "failed" | "unavailable";
  access_method: string; model_or_surface: string | null; provider_request_id: string | null;
  captured_at: string; raw_response: Json | null; answer_text: string | null;
  error_code: string | null; error_message: string | null;
};
export type ActionRow = {
  id: string; workspace_id: string; project_id: string; title: string; description: string;
  status: "proposed" | "approved" | "in_progress" | "completed" | "dismissed";
  expected_impact: string; effort: string; uncertainty: string;
  created_by: string | null; completed_at: string | null; created_at: string; updated_at: string;
};
export type ScheduleRow = {
  id: string; workspace_id: string; project_id: string; question_set_id: string | null;
  providers: ProviderKey[]; name: string; frequency: "daily" | "weekly" | "monthly";
  timezone: string; local_time: string; weekday: number | null; month_day: number | null;
  overlap_policy: "skip" | "queue"; failure_threshold: number; consecutive_failures: number;
  circuit_opened_at: string | null; enabled: boolean; next_run_at: string | null;
  last_run_at: string | null; created_by: string | null; created_at: string; updated_at: string;
};

export type Database = {
  public: {
    Tables: {
      profiles: Table<{ id: string; full_name: string | null; created_at: string; updated_at: string }>;
      workspaces: Table<{ id: string; name: string; slug: string; created_by: string; created_at: string; updated_at: string }>;
      workspace_members: Table<{ workspace_id: string; user_id: string; role: WorkspaceRole; session_not_before: string | null; created_at: string }>;
      workspace_invitations: Table<{ id: string; workspace_id: string | null; invitation_kind: "workspace" | "bootstrap"; email: string; invited_user_id: string | null; role: WorkspaceRole; invited_by: string | null; expires_at: string; accepted_at: string | null; revoked_at: string | null; signup_proof_hash: string; email_reverification_requested_at: string | null; notification_delivery_status: "pending" | "sent" | "failed"; notification_delivery_attempts: number; notification_delivery_last_attempted_at: string | null; notification_delivery_sent_at: string | null; notification_delivery_failure_code: string | null; otp_admission_id: string | null; otp_admission_status: "admitted" | "sent" | "failed" | null; otp_admitted_at: string | null; otp_last_attempted_at: string | null; signup_proof_consumed_at: string | null; created_at: string }>;
      projects: Table<ProjectRow>;
      brands: Table<{ id: string; workspace_id: string; project_id: string; name: string; domain: string; market: string; is_primary: boolean; role: "primary" | "competitor"; created_at: string; updated_at: string }>;
      brand_versions: Table<{ id: string; workspace_id: string; project_id: string; brand_id: string; version: number; name: string; domain: string; role: "primary" | "competitor"; aliases: Json; snapshot_hash: string; created_by: string | null; created_at: string }>;
      questions: Table<QuestionRow>;
      question_versions: Table<{ id: string; workspace_id: string; project_id: string; question_id: string; version: number; prompt: string; question_type: string; persona: string | null; stage: string | null; market: string; locale: string; rationale: string | null; qualification: Json; snapshot_hash: string; created_by: string | null; created_at: string }>;
      question_sets: Table<QuestionSetRow>;
      question_set_items: Table<QuestionSetItemRow>;
      sources: Table<SourceRow>;
      source_versions: Table<{ id: string; workspace_id: string; project_id: string; source_id: string; version: number; content_text: string | null; storage_path: string | null; content_hash: string; mime_type: string | null; retrieved_at: string | null; valid_from: string; valid_until: string | null; retrieval_metadata: Json; retrieval_allowed: boolean; quoting_allowed: boolean; export_allowed: boolean; authority_weight_snapshot: number; freshness_days_snapshot: number; prompt_injection_flags: string[]; created_by: string | null; created_at: string }>;
      source_claims: Table<{ id: string; workspace_id: string; project_id: string; source_version_id: string; claim_text: string; evidence_excerpt: string | null; freshness_state: "current" | "stale" | "unknown"; conflict_group: string | null; authority_weight_snapshot: number; freshness_days_snapshot: number; prompt_injection_flags: string[]; created_by: string | null; created_at: string }>;
      runs: Table<RunRow>;
      run_brand_versions: Table<{ workspace_id: string; project_id: string; run_id: string; brand_version_id: string; role: "primary" | "competitor"; position: number; created_at: string }>;
      run_items: Table<RunItemRow>;
      observations: Table<ObservationRow>;
      citations: Table<{ id: string; workspace_id: string; project_id: string; observation_id: string; source_version_id: string | null; url: string; original_url: string; canonical_url: string; title: string | null; position: number | null; evidence_excerpt: string | null; created_at: string }>;
      brand_classifications: Table<{ id: string; workspace_id: string; project_id: string; classification_run_id: string; observation_id: string; brand_version_id: string; mentioned: boolean; cited: boolean; shortlisted: boolean; explicitly_recommended: boolean; first_choice: boolean; rejected: boolean; rank: number | null; confidence: number; evidence_spans: Json; rationale: string; review_status: string; created_at: string }>;
      classification_runs: Table<{ id: string; workspace_id: string; project_id: string; observation_id: string; classifier_name: string; classifier_version: string; input_hash: string; created_at: string }>;
      classification_reviews: Table<{ id: string; workspace_id: string; project_id: string; classification_id: string; reviewer_id: string | null; decision: "approved" | "overridden"; reason: string; before_value: Json; after_value: Json; created_at: string }>;
      actions: Table<ActionRow>;
      action_links: Table<{ id: string; workspace_id: string; project_id: string; action_id: string; question_version_id: string | null; classification_id: string | null; source_version_id: string | null; rationale: string; created_at: string }>;
      action_run_links: Table<{ id: string; workspace_id: string; project_id: string; action_id: string; run_id: string; relationship_kind: "follow_up_observation"; outcome_note: string; causation_asserted: false; linked_by: string | null; created_at: string }>;
      schedules: Table<ScheduleRow>;
      provider_connections: Table<{ id: string; workspace_id: string; provider: ProviderKey; display_name: string; credential_ciphertext: string | null; configuration: Json; enabled: boolean; health_state: string; remediation: string | null; last_checked_at: string | null; created_by: string | null; created_at: string; updated_at: string }>;
      provider_budget_caps: Table<{ provider: ProviderKey; max_calls_per_capture: number; max_cost_per_capture_usd: number; rationale: string; updated_at: string }>;
      usage_events: Table<{ id: string; workspace_id: string; project_id: string; run_id: string | null; run_item_id: string | null; capture_attempt_id: string | null; provider: ProviderKey | null; call_count: number; search_requests: number | null; input_tokens: number; output_tokens: number; estimated_cost_usd: number; usage_complete: boolean; billing_ambiguous: boolean; idempotency_key: string; occurred_at: string }>;
      workspace_quotas: Table<{ workspace_id: string; monthly_call_limit: number; monthly_cost_limit_usd: number; updated_at: string; updated_by: string | null }>;
      api_tokens: Table<{ id: string; workspace_id: string; name: string; token_prefix: string; token_hash: string; scopes: string[]; created_by: string | null; expires_at: string | null; last_used_at: string | null; revoked_at: string | null; created_at: string }>;
      webhook_endpoints: Table<{ id: string; workspace_id: string; name: string; endpoint_url: string; secret_ciphertext: string; event_names: string[]; enabled: boolean; created_by: string | null; created_at: string; updated_at: string }>;
      webhook_deliveries: Table<{ id: string; workspace_id: string; webhook_endpoint_id: string; event_id: string; event_name: string; payload: Json; status: "pending" | "delivered" | "failed" | "abandoned"; attempt_count: number; next_attempt_at: string | null; response_status: number | null; response_excerpt: string | null; delivered_at: string | null; created_at: string }>;
      api_rate_limit_windows: Table<{ token_id: string; scope: "read" | "run" | "export"; window_started_at: string; request_count: number; updated_at: string }>;
      audit_events: Table<{ id: string; workspace_id: string; actor_user_id: string | null; actor_token_id: string | null; request_id: string | null; event_type: string; entity_type: string; entity_id: string | null; metadata: Json; occurred_at: string }>;
    };
    Views: Record<string, never>;
    Functions: {
      lease_capture_jobs: { Args: { p_worker_id: string; p_limit?: number; p_lease_seconds?: number }; Returns: RunItemRow[] };
      complete_capture_job: { Args: Record<string, unknown>; Returns: string };
      fail_capture_job: { Args: Record<string, unknown>; Returns: JobStatus };
      recover_expired_capture_leases: { Args: { p_now?: string }; Returns: number };
      enqueue_due_schedules: { Args: { p_now?: string }; Returns: number };
      hydrate_capture_job_v2: { Args: { p_job_id: string; p_worker_id: string }; Returns: Json };
      complete_capture_job_v2: { Args: Record<string, unknown>; Returns: string };
      fail_capture_job_v2: { Args: Record<string, unknown>; Returns: JobStatus };
      create_monitoring_run: { Args: { p_workspace_id: string; p_project_id: string; p_actor_id: string; p_question_version_ids: string[]; p_providers: ProviderKey[]; p_idempotency_key: string; p_estimated_max_cost_usd?: number | null }; Returns: string };
      create_question_set: { Args: { p_workspace_id: string; p_project_id: string; p_actor_id: string; p_name: string; p_question_version_ids: string[] }; Returns: string };
      create_evidence_source: { Args: { p_workspace_id: string; p_project_id: string; p_actor_id: string; p_kind: "url" | "text" | "file"; p_name: string; p_original_url: string | null; p_canonical_url: string | null; p_content_text: string | null; p_storage_path: string | null; p_content_hash: string; p_mime_type: string | null; p_retrieved_at: string | null; p_retrieval_metadata: Json; p_retrieval_allowed: boolean; p_quoting_allowed: boolean; p_export_allowed: boolean }; Returns: string };
      create_quality_evidence_source: { Args: { p_workspace_id: string; p_project_id: string; p_actor_id: string; p_kind: "url" | "text" | "file"; p_name: string; p_original_url: string | null; p_canonical_url: string | null; p_content_text: string | null; p_storage_path: string | null; p_content_hash: string; p_mime_type: string | null; p_retrieved_at: string | null; p_retrieval_metadata: Json; p_retrieval_allowed: boolean; p_quoting_allowed: boolean; p_export_allowed: boolean; p_authority_weight: number; p_freshness_days: number }; Returns: string };
      append_evidence_source_version: { Args: { p_workspace_id: string; p_project_id: string; p_source_id: string; p_actor_id: string; p_content_text: string | null; p_storage_path: string | null; p_content_hash: string; p_mime_type: string | null; p_retrieved_at: string | null; p_retrieval_metadata: Json }; Returns: string };
      append_quality_evidence_source_version: { Args: { p_workspace_id: string; p_project_id: string; p_source_id: string; p_actor_id: string; p_content_text: string | null; p_storage_path: string | null; p_content_hash: string; p_mime_type: string | null; p_retrieved_at: string | null; p_retrieval_metadata: Json; p_authority_weight: number; p_freshness_days: number }; Returns: string };
      archive_evidence_source: { Args: { p_workspace_id: string; p_project_id: string; p_source_id: string; p_actor_id: string }; Returns: string };
      record_evidence_claim: { Args: { p_workspace_id: string; p_project_id: string; p_source_version_id: string; p_actor_id: string; p_claim_text: string; p_evidence_excerpt: string | null; p_conflict_group: string | null }; Returns: string };
      create_action_with_lineage: { Args: { p_workspace_id: string; p_project_id: string; p_actor_id: string; p_title: string; p_description: string; p_expected_impact: string | null; p_effort: string | null; p_uncertainty: string | null; p_question_version_id: string | null; p_classification_id: string | null; p_source_version_id: string | null; p_rationale: string }; Returns: string };
      transition_action_with_follow_up: { Args: { p_workspace_id: string; p_project_id: string; p_actor_id: string; p_action_id: string; p_status: ActionRow["status"]; p_follow_up_run_id: string | null; p_outcome_note: string | null }; Returns: string };
      cancel_monitoring_run: { Args: { p_workspace_id: string; p_run_id: string; p_actor_id: string; p_reason: string }; Returns: Json };
      submit_classification_review: { Args: { p_workspace_id: string; p_project_id: string; p_actor_id: string; p_classification_id: string; p_decision: "approved" | "overridden"; p_reason: string; p_after_value: Json }; Returns: string };
      revoke_workspace_invitation: { Args: { p_workspace_id: string; p_actor_id: string; p_invitation_id: string }; Returns: string };
      accept_workspace_invitation: { Args: { p_invitation_id: string; p_user_id: string; p_verified_at: string }; Returns: string };
      bootstrap_workspace_from_invitation: { Args: { p_invitation_id: string; p_user_id: string; p_name: string; p_slug: string; p_verified_at: string }; Returns: string };
      record_invitation_notification_delivery: { Args: { p_invitation_id: string; p_succeeded: boolean; p_failure_code: string | null; p_actor_id?: string | null }; Returns: Json };
      admit_invitation_mailbox_otp: { Args: { p_invitation_id: string; p_signup_proof_hash?: string | null; p_authenticated_user_id?: string | null; p_existing_user_id?: string | null }; Returns: Json };
      finalize_invitation_mailbox_otp: { Args: { p_invitation_id: string; p_attempt_id: string; p_succeeded: boolean; p_failure_code?: string | null }; Returns: Json };
      delete_workspace: { Args: { p_workspace_id: string; p_actor_id: string; p_confirmation: string; p_reauthentication_method: "password" | "otp"; p_reauthenticated_at: string }; Returns: Json };
      revive_abandoned_storage_cleanup_jobs: { Args: { p_now?: string; p_limit?: number }; Returns: number };
      reset_schedule_circuit: { Args: { p_workspace_id: string; p_project_id: string; p_schedule_id: string; p_actor_id: string }; Returns: string };
    };
    Enums: {
      workspace_role: WorkspaceRole; provider_key: ProviderKey; run_status: RunStatus;
      action_status: ActionRow["status"];
      job_status: JobStatus; observation_status: "succeeded" | "failed" | "unavailable";
    };
    CompositeTypes: Record<string, never>;
  };
};
