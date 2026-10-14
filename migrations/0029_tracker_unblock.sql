-- Synced issues are editable locally; the import merge keeps local edits.
DROP TRIGGER protect_openproject_issue ON issues;
DROP TRIGGER protect_openproject_source_link ON source_links;
DROP TRIGGER protect_openproject_attachment_removal ON attachments;
DROP FUNCTION protect_openproject_issue();
DROP FUNCTION protect_openproject_local_record();
