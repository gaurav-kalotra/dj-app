.PHONY: backend frontend install install-backend install-frontend smoke dev

VENV_PY  := backend/.venv/Scripts/python
VENV_PIP := backend/.venv/Scripts/pip
VENV_UV  := backend/.venv/Scripts/uvicorn

# ── setup ────────────────────────────────────────────────────────────────────

install: install-backend install-frontend

install-backend:
	python -m venv backend/.venv
	$(VENV_PIP) install --upgrade pip
	$(VENV_PIP) install -e "backend[dev]"

install-frontend:
	cd frontend && npm install

# ── run ──────────────────────────────────────────────────────────────────────

backend:
	$(VENV_UV) axiom.main:app --reload --port 8888

frontend:
	cd frontend && npm run dev

dev:
	@echo ""
	@echo "  AXIOM — start dev servers in two terminals:"
	@echo "    Terminal 1:  make backend"
	@echo "    Terminal 2:  make frontend"
	@echo "  Then open http://localhost:5173"
	@echo ""

# ── gate ─────────────────────────────────────────────────────────────────────

smoke:
	$(VENV_PY) scripts/smoke_test.py
