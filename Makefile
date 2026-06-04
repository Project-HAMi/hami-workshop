.PHONY: serve build clean install

PYTHON ?= python3
VENV := .venv
PIP := $(VENV)/bin/pip
MKDOCS := $(VENV)/bin/mkdocs

install:
	$(PYTHON) -m venv $(VENV)
	$(PIP) install -r requirements.txt

serve: install
	$(MKDOCS) serve

build: install
	$(MKDOCS) build

clean:
	rm -rf site
