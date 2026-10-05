UPDATE jobs SET payload=payload-'secret' WHERE kind='webhook' AND payload ? 'secret';
UPDATE jobs SET payload=payload-'token' WHERE kind='email' AND state IN ('succeeded','failed','cancelled') AND payload ? 'token';
