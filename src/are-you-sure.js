"use strict";

/**
 * Wires up a yes/no question asked through an existing bootstrap modal.
 *
 * @param {HTMLElement} element the modal's element
 * @param {{show: function, hide: function}} modal the bootstrap modal controlling that element
 * @returns {function(string, string, string, function)} asks the question, running the callback only on "yes"
 */
export function makeAreYouSure(element, modal) {
    return function areYouSure(message, yesText, noText, yesFunc) {
        const yesButton = element.querySelector(".ays-yes");
        element.querySelector(".context").textContent = message;
        element.querySelector(".ays-no").textContent = noText;
        yesButton.textContent = yesText;
        let confirmed = false;
        const onYes = () => {
            confirmed = true;
            modal.hide();
        };
        yesButton.addEventListener("click", onYes, { once: true });
        // Acting on hiding rather than on the click means the "no" button, Escape and a click outside all
        // come to the same thing, and that the modal is gone before yesFunc runs.
        element.addEventListener(
            "hidden.bs.modal",
            () => {
                yesButton.removeEventListener("click", onYes);
                if (confirmed) yesFunc();
            },
            { once: true },
        );
        modal.show();
    };
}
