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
	@rm -rf out/build out/dist
	@mkdir -p out/dist
	@mkdir -p out/build
	cp -r *.js *.css *.html *.txt *.ico discs tapes basic images lib roms sounds out/build
	mkdir out/build/app && cp app/electron.js out/build/app
	for BASEFILE in main requirejs-common; do \
		perl -pi -e "s/require\(\['$${BASEFILE}'\]/require(['$${BASEFILE}-$(HASH)']/" out/build/index.html; \
		mv out/build/$${BASEFILE}.js out/build/$${BASEFILE}-$(HASH).js; \
	done
	m4 -DHASH=$(HASH) -DDEPLOY_DIR=$(shell pwd)/out/dist '-DCOMMON_SETTINGS=$(shell $(NODE) -e 'requirejs = {config: function(c) { c.baseUrl = "."; console.log(JSON.stringify(c)); }}; require("./requirejs-common.js");' | sed 's/^.\(.*\).$$/\1/')' build.js.template > out/build.js
	cd out/build && $(shell pwd)/node_modules/requirejs/bin/r.js -o ../build.js

.PHONY: upload
upload: dist
	aws s3 sync out/dist/ s3://bbc.godbolt.org/$(BRANCH) --cache-control max-age=30 --metadata-directive REPLACE

.PHONY: clean
clean:
	@rm -rf out

.PHONY: spotless
spotless: clean
	@rm -f $(NPM_UP_TO_DATE)
