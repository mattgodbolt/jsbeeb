all: test

PHANTOMJS:=node_modules/phantomjs/bin/phantomjs
$(PHANTOMJS):
	npm install phantomjs

test: $(PHANTOMJS)
	$(PHANTOMJS) tests/phantom-tests.js
