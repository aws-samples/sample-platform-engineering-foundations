# NetworkPolicy demo

Apply all YAML files through Argo CD. The expected controls are:

- `frontend` reaches `backend:8080`.
- `backend` reaches `db:5432`.
- `frontend` cannot reach `db:5432`.
- Removing `netpol-db.yaml` from the local Git repository makes the last probe succeed. Reverting the commit blocks it again.

Run the paired checks twice before and during the disconnected test. A policy object by itself is not proof of enforcement.
