NPM_UP_TO_DATE:=.npm-up-to-date
NODE=node
NPM=npm

.PHONY: all
all: test

npm: $(NPM_UP_TO_DATE)

.PHONY: npm
test: npm
	$(NPM) test

$(NPM_UP_TO_DATE): package.json
	$(NPM) install
	touch $(NPM_UP_TO_DATE)

HASH := $(shell git rev-parse HEAD)

.PHONY: dist
dist: npm
	npm run build

.PHONY: upload
upload: dist
	aws s3 sync out/dist/ s3://bbc.godbolt.org/$(BRANCH) --cache-control max-age=30 --metadata-directive REPLACE

.PHONY: clean
clean:
	@rm -rf out

.PHONY: spotless
spotless: clean
	@rm -f $(NPM_UP_TO_DATE)
