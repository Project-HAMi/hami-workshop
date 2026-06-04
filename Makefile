.PHONY: serve build clean install

VENV := .venv
PIP := $(VENV)/bin/pip
MKDOCS := $(VENV)/bin/mkdocs

install:
	python3 -m venv $(VENV)
	$(PIP) install -r requirements.txt

serve: install
	$(MKDOCS) serve

build: install
	$(MKDOCS) build

clean:
	rm -rf site
