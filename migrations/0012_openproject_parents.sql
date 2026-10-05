-- Page transactions link already-imported children of arriving packages.
CREATE INDEX issues_openproject_parent ON issues(workspace_id, (openproject->>'connection_id'), (openproject->>'parent_work_package_id')) WHERE openproject IS NOT NULL;
