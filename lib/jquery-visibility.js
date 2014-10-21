/*! http://mths.be/visibility v1.0.7 by @mathias | MIT license */
;(function(window, document, $, undefined) {

	var prefix;
	var property;
	// In Opera, `'onfocusin' in document == true`, hence the extra `hasFocus` check to detect IE-like behavior
	var eventName = 'onfocusin' in document && 'hasFocus' in document
		? 'focusin focusout'
		: 'focus blur';
	var prefixes = ['webkit', 'o', 'ms', 'moz', ''];
	var $support = $.support;
	var $event = $.event;

	while ((prefix = prefixes.pop()) != undefined) {
		property = (prefix ? prefix + 'H': 'h') + 'idden';
		if ($support.pageVisibility = typeof document[property] == 'boolean') {
			eventName = prefix + 'visibilitychange';
			break;
		}
	}

	$(/blur$/.test(eventName) ? window : document).on(eventName, function(event) {
		var type = event.type;
		var originalEvent = event.originalEvent;

		// Avoid errors from triggered native events for which `originalEvent` is
		// not available.
		if (!originalEvent) {
			return;
		}

		var toElement = originalEvent.toElement;

		// If it’s a `{focusin,focusout}` event (IE), `fromElement` and `toElement`
		// should both be `null` or `undefined`; else, the page visibility hasn’t
		// changed, but the user just clicked somewhere in the doc. In IE9, we need
		// to check the `relatedTarget` property instead.
		if (
			!/^focus./.test(type) || (
				toElement == undefined &&
				originalEvent.fromElement == undefined &&
				originalEvent.relatedTarget == undefined
			)
		) {
			$event.trigger(
				(
					property && document[property] || /^(?:blur|focusout)$/.test(type)
						? 'hide'
						: 'show'
				) + '.visibility'
			);
		}
	});

}(this, document, jQuery));
