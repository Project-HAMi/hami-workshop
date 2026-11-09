.PHONY: serve build clean install diagrams

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

PDG ?= pdg
diagrams:
	for f in examples/hami-lab/diagrams/*.pdg; do $(PDG) --target web -o docs/images/hami-lab-$$(basename $${f%.pdg}).svg $$f; done
