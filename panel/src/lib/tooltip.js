export function tooltip(node, params) {
  let tooltipElement;
  let text = '';
  let preferredPlacement = 'auto';

  function parseParams(p) {
    if (typeof p === 'string') {
      text = p;
    } else if (p) {
      text = p.text;
      if (p.placement) preferredPlacement = p.placement;
    }
  }
  parseParams(params);

  function show() {
    if (!text) return;
    if (tooltipElement) return;
    
    tooltipElement = document.createElement('div');
    tooltipElement.className = "pointer-events-none absolute z-[9999] rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-white shadow-md opacity-0 transition-opacity duration-200 max-w-[200px] text-center";
    tooltipElement.textContent = text;
    
    // Arrow
    const arrow = document.createElement('div');
    tooltipElement.appendChild(arrow);

    document.body.appendChild(tooltipElement);
    
    requestAnimationFrame(() => {
      if (!tooltipElement) return;
      const rect = node.getBoundingClientRect();
      const tooltipRect = tooltipElement.getBoundingClientRect();
      
      const gap = 8;
      
      const spaceTop = rect.top;
      const spaceBottom = window.innerHeight - rect.bottom;
      const spaceLeft = rect.left;
      const spaceRight = window.innerWidth - rect.right;
      
      const neededHorizontalHalf = tooltipRect.width / 2;
      const buttonCenter = rect.left + (rect.width / 2);
      
      const fitsTop = spaceTop >= tooltipRect.height + gap;
      const fitsBottom = spaceBottom >= tooltipRect.height + gap;
      const fitsLeft = spaceLeft >= tooltipRect.width + gap;
      const fitsRight = spaceRight >= tooltipRect.width + gap;
      
      const fitsTopCentered = fitsTop && buttonCenter >= neededHorizontalHalf && (window.innerWidth - buttonCenter) >= neededHorizontalHalf;
      const fitsBottomCentered = fitsBottom && buttonCenter >= neededHorizontalHalf && (window.innerWidth - buttonCenter) >= neededHorizontalHalf;
      
      const order = [];
      if (preferredPlacement === 'left') order.push('left', 'right', 'top', 'bottom');
      else if (preferredPlacement === 'right') order.push('right', 'left', 'top', 'bottom');
      else if (preferredPlacement === 'bottom') order.push('bottom', 'top', 'left', 'right');
      else order.push('top', 'bottom', 'left', 'right'); // auto

      let placement = 'top'; // ultimate fallback
      for (const p of order) {
        if (p === 'top' && fitsTopCentered) { placement = 'top'; break; }
        if (p === 'bottom' && fitsBottomCentered) { placement = 'bottom'; break; }
        if (p === 'left' && fitsLeft) { placement = 'left'; break; }
        if (p === 'right' && fitsRight) { placement = 'right'; break; }
      }
      
      // If we still haven't found a perfect fit, let's use the preferred one if it's left/right,
      // otherwise fallback to top/bottom which can be clamped horizontally.
      if (placement === 'top' && !fitsTopCentered) {
        if (preferredPlacement === 'left' && spaceLeft > spaceRight) placement = 'left';
        else if (fitsTop) placement = 'top';
        else if (fitsBottom) placement = 'bottom';
      }

      let top, left, arrowClass, arrowStyle = '';
      
      if (placement === 'left') {
        top = rect.top + window.scrollY + (rect.height / 2) - (tooltipRect.height / 2);
        left = rect.left + window.scrollX - tooltipRect.width - gap;
        arrowClass = 'absolute h-2 w-2 rotate-45 bg-slate-800 -right-1 top-1/2 -mt-1';
      } else if (placement === 'right') {
        top = rect.top + window.scrollY + (rect.height / 2) - (tooltipRect.height / 2);
        left = rect.right + window.scrollX + gap;
        arrowClass = 'absolute h-2 w-2 rotate-45 bg-slate-800 -left-1 top-1/2 -mt-1';
      } else if (placement === 'top') {
        top = rect.top + window.scrollY - tooltipRect.height - gap;
        left = rect.left + window.scrollX + (rect.width / 2) - (tooltipRect.width / 2);
        if (left < 10) left = 10;
        if (left + tooltipRect.width > window.innerWidth - 10) left = window.innerWidth - tooltipRect.width - 10;
        let arrowLeft = (rect.left + window.scrollX + rect.width / 2) - left;
        if (arrowLeft < 12) arrowLeft = 12;
        if (arrowLeft > tooltipRect.width - 12) arrowLeft = tooltipRect.width - 12;
        arrowClass = 'absolute h-2 w-2 rotate-45 bg-slate-800 -bottom-1';
        arrowStyle = `left: ${arrowLeft}px; margin-left: -4px;`;
      } else if (placement === 'bottom') {
        top = rect.bottom + window.scrollY + gap;
        left = rect.left + window.scrollX + (rect.width / 2) - (tooltipRect.width / 2);
        if (left < 10) left = 10;
        if (left + tooltipRect.width > window.innerWidth - 10) left = window.innerWidth - tooltipRect.width - 10;
        let arrowLeft = (rect.left + window.scrollX + rect.width / 2) - left;
        if (arrowLeft < 12) arrowLeft = 12;
        if (arrowLeft > tooltipRect.width - 12) arrowLeft = tooltipRect.width - 12;
        arrowClass = 'absolute h-2 w-2 rotate-45 bg-slate-800 -top-1';
        arrowStyle = `left: ${arrowLeft}px; margin-left: -4px;`;
      }

      tooltipElement.style.top = `${top}px`;
      tooltipElement.style.left = `${left}px`;
      
      arrow.className = arrowClass;
      arrow.style.cssText = arrowStyle;

      tooltipElement.style.opacity = '1';
    });
  }

  function hide() {
    if (tooltipElement) {
      const el = tooltipElement;
      el.style.opacity = '0';
      setTimeout(() => {
        if (el && document.body.contains(el)) document.body.removeChild(el);
      }, 200);
      tooltipElement = null;
    }
  }

  let isHovered = false;
  let isFocused = false;

  function handleMouseenter() {
    isHovered = true;
    show();
  }

  function handleMouseleave() {
    isHovered = false;
    if (!isFocused) hide();
  }

  function handleFocus() {
    isFocused = true;
    show();
  }

  function handleBlur() {
    isFocused = false;
    if (!isHovered) hide();
  }

  node.addEventListener('mouseenter', handleMouseenter);
  node.addEventListener('mouseleave', handleMouseleave);
  node.addEventListener('focus', handleFocus);
  node.addEventListener('blur', handleBlur);
  
  // Hide on scroll of the document to prevent detached tooltips
  window.addEventListener('scroll', hide, { passive: true });

  return {
    update(newText) {
      text = newText;
      if (tooltipElement) {
        tooltipElement.firstChild.textContent = text;
      }
    },
    destroy() {
      hide();
      node.removeEventListener('mouseenter', handleMouseenter);
      node.removeEventListener('mouseleave', handleMouseleave);
      node.removeEventListener('focus', handleFocus);
      node.removeEventListener('blur', handleBlur);
      window.removeEventListener('scroll', hide);
    }
  };
}
