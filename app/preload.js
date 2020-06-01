window.addEventListener('DOMContentLoaded', () => {
    for (const node of document.getElementsByClassName("not-electron")) {
        node.remove();
    }
});
